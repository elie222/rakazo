import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { promises as dnsPromises } from "node:dns";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import {
  ComposioConnector,
  EncryptedSecretStore,
  FakeBrowserProvider,
  FakeComposioClient,
  pageBrowserSessionKey,
  ScriptedAgentRuntime,
} from "@rakazo/adapters";
import type { createApp } from "@rakazo/api/app";
import { resolveEncryptionKey } from "@rakazo/core";
import { answerRunInput, findPendingAsk, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { asSystem } from "./system-db.js";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;
const destination = {
  name: "example_api",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
};
const key = "fake-reusable-api-key";
const inboundEmail = { domain: "bots.rakazo.test", secret: "test-inbound-email-secret-0123456789" };

describeIntegration("reusable credential lifecycle", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let db: Awaited<ReturnType<typeof createApp>>["prisma"];
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-secret-lifecycle-"));
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  /** The integration the owner connects their own mailbox through. */
  const connectedMail = new FakeComposioClient();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const auth = new Headers(init?.headers).get("Authorization");
    return Response.json({
      authenticated: auth === `Bearer ${key}` || auth === `Bearer ${key}-rotated`,
      echo: auth,
    });
  });

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
      inboundEmail,
      composio: new ComposioConnector({ client: connectedMail }),
      remoteConnectors: {
        fetch,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      },
    });
    db = asSystem(handles.prisma);
  });
  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.each([false, true])(
    "saves, reuses, rotates and revokes without model-visible plaintext (approval rule: %s)",
    async (requireApproval) => {
      fetch.mockClear();
      const seen: string[] = [];
      let calls: Array<{ name: string; args: Record<string, unknown> }> = [
        {
          name: "request_secret",
          args: { label: "API key", purpose: "api_key", credential: destination },
        },
      ];
      const runtime = vi
        .spyOn(ScriptedAgentRuntime.prototype, "run")
        .mockImplementation(async function* (request): AsyncIterable<AgentRuntimeEvent> {
          seen.push(
            JSON.stringify({
              prompt: request.prompt,
              history: request.history,
              tools: request.tools,
            }),
          );
          for (const [index, call] of calls.entries()) {
            yield { type: "tool", ...call, executionId: `${request.runId}:${index}` };
          }
          yield { type: "done", text: "Done" };
        });
      try {
        const seeded = await seedRun(`reusable-${requireApproval}`, "Save the API credential");
        // The owner allowed using and forgetting saved credentials, so only request_secret asks.
        await db.userActionApprovalRule.createMany({
          data: ["secret_request", "forget_secret"].map((matchValue) => ({
            userId: seeded.me.userId,
            effect: "always_allow",
            matchKind: "tool",
            matchValue,
          })),
        });
        if (requireApproval) {
          await db.userActionApprovalRule.create({
            data: {
              userId: seeded.me.userId,
              effect: "require_approval",
              matchKind: "tool",
              matchValue: "request_secret",
            },
          });
        }
        await runAsSystem("background job run.continue", () =>
          handles.executor.continueRun(seeded.run.id, "test-worker"),
        );
        const approve = async (runId: string, interruptBeforeCard = false) => {
          if (!requireApproval) return;
          // A just-continued run can still sit requeued while the previous run's
          // worker releases the computer lease, so the card may land a moment later.
          const message = await vi.waitFor(
            async () =>
              db.message.findFirstOrThrow({
                where: { runId, role: "bot" },
                orderBy: { createdAt: "desc" },
              }),
            { timeout: 15_000 },
          );
          expect(message.blocks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ approvalEffectId: expect.any(String) }),
            ]),
          );
          if (interruptBeforeCard) {
            // Reproduce a worker stopping after releasing the approved effect to intended,
            // before the protected card transaction commits. No background job is enqueued.
            expect(
              await runAsTenant(seeded.me, () =>
                answerRunInput(handles.prisma, {
                  spaceId: seeded.me.spaceId,
                  threadId: seeded.thread.id,
                  runId,
                  messageId: message.id,
                  answeredByUserId: seeded.me.userId,
                  answer: "allow",
                }),
              ),
            ).toBe(true);
            await db.externalEffect.updateMany({
              where: { runId, kind: "request_secret", status: "approved" },
              data: { status: "intended" },
            });
            await db.run.update({
              where: { id: runId },
              data: {
                status: "running",
                leaseOwner: "interrupted-worker",
                leaseExpiresAt: new Date(Date.now() - 60_000),
              },
            });
            await runAsSystem("background job run.continue", () =>
              handles.executor.continueRun(runId, "recovery-worker"),
            );
          } else {
            await rpc(seeded.cookie, "threads/answer", {
              botId: seeded.bot.id,
              runId,
              messageId: message.id,
              answer: "allow",
            });
          }
          await vi.waitFor(
            async () => {
              const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
              expect(["completed", "waiting_input"]).toContain(run.status);
            },
            { timeout: 15_000 },
          );
        };
        await approve(seeded.run.id);
        const answer = async (runId: string, value: string) => {
          const message = await db.message.findFirstOrThrow({
            where: { runId, role: "bot" },
            orderBy: { createdAt: "desc" },
          });
          expect(message.blocks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ input: "secret", credential: destination }),
            ]),
          );
          await rpc(seeded.cookie, "threads/answer", {
            botId: seeded.bot.id,
            runId,
            messageId: message.id,
            answer: value,
          });
          await vi.waitFor(
            async () => {
              expect(await db.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
                status: "completed",
                error: null,
              });
            },
            { timeout: 15_000 },
          );
        };
        expect(await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).toMatchObject({
          status: "waiting_input",
          error: null,
        });
        // An invalid value rolls back the run transition and leaves the card pending.
        const pending = await db.message.findFirstOrThrow({
          where: { runId: seeded.run.id, role: "bot" },
          orderBy: { seq: "desc" },
        });
        expect(pending.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "ask",
              input: "secret",
              status: "pending",
              credential: destination,
            }),
          ]),
        );
        for (const invalid of ["x".repeat(16_385), "key\r\nX-Evil: injected", "key "]) {
          await expect(
            rpc(seeded.cookie, "threads/answer", {
              botId: seeded.bot.id,
              runId: seeded.run.id,
              messageId: pending.id,
              answer: invalid,
            }),
          ).rejects.toThrow();
        }
        expect(await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).toMatchObject({
          status: "waiting_input",
        });
        expect(await db.vaultCredential.count({ where: { userId: seeded.me.userId } })).toBe(0);
        await answer(seeded.run.id, key);
        const stored = await db.vaultCredential.findFirstOrThrow({
          where: { userId: seeded.me.userId },
        });
        // Saved in the account vault, which the Space uses until it has its own.
        expect(stored).toMatchObject({
          ...destination,
          userId: seeded.me.userId,
          spaceId: null,
        });
        expect(stored.ciphertext).toMatch(/^v2:/);
        expect(stored.ciphertext).not.toContain(key);
        expect(await db.secret.count({ where: { kind: `run-secret:${seeded.run.id}` } })).toBe(0);

        const nextRun = async (nextCalls: typeof calls) => {
          calls = nextCalls;
          const task = await db.task.create({
            data: {
              userId: seeded.me.userId,
              spaceId: seeded.me.spaceId,
              botId: seeded.bot.id,
              threadId: seeded.thread.id,
              prompt: "Use the saved credential",
              status: "queued",
            },
          });
          const run = await db.run.create({
            data: {
              userId: seeded.me.userId,
              spaceId: seeded.me.spaceId,
              botId: seeded.bot.id,
              threadId: seeded.thread.id,
              taskId: task.id,
              trigger: "user",
              status: "queued",
            },
          });
          await runAsSystem("background job run.continue", () =>
            handles.executor.continueRun(run.id, "test-worker"),
          );
          return run.id;
        };
        const request = {
          name: "secret_request",
          args: { name: destination.name, url: `${destination.origin}/v1/items` },
        };
        const useRun = await nextRun([
          { name: "list_secrets", args: {} },
          {
            name: "request_secret",
            args: { label: "API key", purpose: "api_key", credential: destination },
          },
          request,
        ]);
        await approve(useRun);
        await vi.waitFor(
          async () => {
            expect(await db.run.findUniqueOrThrow({ where: { id: useRun } })).toMatchObject({
              status: "completed",
              error: null,
            });
          },
          { timeout: 15_000 },
        );
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(
          await db.externalEffect.findFirstOrThrow({
            where: { runId: useRun, kind: "secret_request" },
          }),
        ).toMatchObject({
          status: "completed",
          result: {
            status: 200,
            body: { authenticated: true, echo: expect.stringContaining("[redacted]") },
          },
        });

        const rotateRun = await nextRun([
          {
            name: "request_secret",
            args: { label: "API key", purpose: "api_key", credential: destination, replace: true },
          },
        ]);
        await vi.waitFor(
          async () => {
            expect(await db.run.findUniqueOrThrow({ where: { id: rotateRun } })).toMatchObject({
              status: "waiting_input",
            });
          },
          { timeout: 15_000 },
        );
        await approve(rotateRun, true);
        expect(await db.run.findUniqueOrThrow({ where: { id: rotateRun } })).toMatchObject({
          status: "waiting_input",
        });
        expect(
          await db.vaultCredential.findUniqueOrThrow({ where: { id: stored.id } }),
        ).toMatchObject({
          ciphertext: stored.ciphertext,
        });
        await answer(rotateRun, `${key}-rotated`);
        expect(
          await db.vaultCredential.findUniqueOrThrow({ where: { id: stored.id } }),
        ).not.toMatchObject({ ciphertext: stored.ciphertext });
        const rotatedUse = await nextRun([request]);
        await vi.waitFor(
          async () => {
            expect(await db.run.findUniqueOrThrow({ where: { id: rotatedUse } })).toMatchObject({
              status: "completed",
              error: null,
            });
          },
          { timeout: 15_000 },
        );
        expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get("Authorization")).toBe(
          `Bearer ${key}-rotated`,
        );
        const count = fetch.mock.calls.length;
        const forgotten = await nextRun([
          { name: "forget_secret", args: { name: destination.name } },
          request,
        ]);
        // The deletion alone does not prove the run finished: the trailing use request and
        // its writes can still be pending. Wait for the run itself, then assert the effects.
        await vi.waitFor(
          async () => {
            expect(await db.run.findUniqueOrThrow({ where: { id: forgotten } })).toMatchObject({
              status: "completed",
              error: null,
            });
          },
          { timeout: 15_000 },
        );
        expect(await db.vaultCredential.count({ where: { userId: seeded.me.userId } })).toBe(0);
        expect(fetch).toHaveBeenCalledTimes(count);
        const [messages, events, effects, tasks] = await Promise.all([
          db.message.findMany({ where: { threadId: seeded.thread.id } }),
          db.event.findMany({ where: { threadId: seeded.thread.id } }),
          db.externalEffect.findMany({ where: { spaceId: seeded.me.spaceId } }),
          db.task.findMany({ where: { botId: seeded.bot.id } }),
        ]);
        expect(JSON.stringify({ seen, messages, events, effects, tasks })).not.toContain(key);
      } finally {
        runtime.mockRestore();
      }
    },
  );

  it("reuses a website login saved for the same site under another name", async () => {
    const site = "https://www.login.example.test";
    const password = "fake-site-password-3b9e";
    const seen: string[] = [];
    let calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestLogin = (name: string, origin = site) => ({
      name: "request_secret",
      args: {
        label: "Sign in",
        purpose: "password",
        credential: { name, origin, auth: { type: "login" } },
        fields: ["Username", "Password"],
      },
    });
    const runtime = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation(async function* (request): AsyncIterable<AgentRuntimeEvent> {
        seen.push(JSON.stringify({ prompt: request.prompt, history: request.history }));
        for (const [index, call] of calls.entries()) {
          yield { type: "tool", ...call, executionId: `${request.runId}:${index}` };
        }
        yield { type: "done", text: "Done" };
      });
    try {
      calls = [requestLogin("site_login")];
      const seeded = await seedRun("site-login", "Sign in to the site");
      await runAsSystem("background job run.continue", () =>
        handles.executor.continueRun(seeded.run.id, "test-worker"),
      );
      const card = await db.message.findFirstOrThrow({
        where: { runId: seeded.run.id, role: "bot" },
        orderBy: { seq: "desc" },
      });
      await rpc(seeded.cookie, "threads/answer", {
        botId: seeded.bot.id,
        runId: seeded.run.id,
        messageId: card.id,
        answer: "",
        fields: [
          { label: "Username", value: "fake-user", hidden: false },
          { label: "Password", value: password, hidden: true },
        ],
      });
      await vi.waitFor(
        async () => {
          expect(await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).toMatchObject({
            status: "completed",
            error: null,
          });
        },
        { timeout: 15_000 },
      );

      const nextRun = async (owner: typeof seeded, nextCalls: typeof calls) => {
        calls = nextCalls;
        const task = await db.task.create({
          data: {
            userId: owner.me.userId,
            spaceId: owner.me.spaceId,
            botId: owner.bot.id,
            threadId: owner.thread.id,
            prompt: "Sign in again",
            status: "queued",
          },
        });
        const run = await db.run.create({
          data: {
            userId: owner.me.userId,
            spaceId: owner.me.spaceId,
            botId: owner.bot.id,
            threadId: owner.thread.id,
            taskId: task.id,
            trigger: "user",
            status: "queued",
          },
        });
        await runAsSystem("background job run.continue", () =>
          handles.executor.continueRun(run.id, "test-worker"),
        );
        return db.run.findUniqueOrThrow({ where: { id: run.id } });
      };

      // Another name for the same site gets the saved login's name, without a card.
      const reused = await nextRun(seeded, [requestLogin("my_site_account")]);
      await vi.waitFor(
        async () => {
          expect(await db.run.findUniqueOrThrow({ where: { id: reused.id } })).toMatchObject({
            status: "completed",
            error: null,
          });
        },
        { timeout: 15_000 },
      );
      expect(
        await db.externalEffect.findFirstOrThrow({
          where: { runId: reused.id, kind: "request_secret" },
        }),
      ).toMatchObject({
        status: "completed",
        result: { saved: true, name: "site_login", origin: site, auth: { type: "login" } },
      });
      // The host without www. is another site.
      const bare = await nextRun(seeded, [
        requestLogin("bare_login", "https://login.example.test"),
      ]);
      await vi.waitFor(
        async () => {
          expect(await db.run.findUniqueOrThrow({ where: { id: bare.id } })).toMatchObject({
            status: "waiting_input",
          });
        },
        { timeout: 15_000 },
      );
      // Another member's vault is not searched.
      const other = await seedRun("site-login-other", "Sign in to the site");
      const otherRun = await nextRun(other, [requestLogin("my_site_account")]);
      await vi.waitFor(
        async () => {
          expect(await db.run.findUniqueOrThrow({ where: { id: otherRun.id } })).toMatchObject({
            status: "waiting_input",
          });
        },
        { timeout: 15_000 },
      );
      expect(await db.vaultCredential.count({ where: { origin: site } })).toBe(1);

      const [messages, events, effects] = await Promise.all([
        db.message.findMany({ where: { threadId: seeded.thread.id } }),
        db.event.findMany({ where: { threadId: seeded.thread.id } }),
        db.externalEffect.findMany({ where: { spaceId: seeded.me.spaceId } }),
      ]);
      expect(JSON.stringify({ seen, messages, events, effects })).not.toContain(password);
    } finally {
      runtime.mockRestore();
    }
  });

  it("moves a saved login to the site of the card answered last, with that card's value", async () => {
    const www = { name: "acme", origin: "https://www.acme.example.test", auth: { type: "login" } };
    const sites = {
      login: { ...www, origin: "https://login.acme.example.test" },
      other: { ...www, origin: "https://acme-insure.example.test" },
    };
    const runtime = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation(async function* (request): AsyncIterable<AgentRuntimeEvent> {
        const credential = request.runId === runs.login.runId ? sites.login : sites.other;
        yield {
          type: "tool",
          name: "request_secret",
          args: { label: "Sign in", purpose: "password", credential, replace: true },
          executionId: `${request.runId}:0`,
        };
        yield { type: "done", text: "Done" };
      });
    const runs = {} as Record<keyof typeof sites, { runId: string; botId: string; card: string }>;
    try {
      const seeded = await seedRun("login-replace", "Sign in");
      const { userId, spaceId } = seeded.me;
      await rpc(seeded.cookie, "vault/put", {
        destination: www,
        value: JSON.stringify({ username: "fake-user", password: "fake-password-www" }),
      });
      const saved = await db.vaultCredential.findFirstOrThrow({ where: { userId } });
      // A second bot of the same member asks to replace the same login for another site.
      const bot = await rpc<{ id: string }>(seeded.cookie, "bots/create", {
        name: "Executor login-replace 2",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      const thread = await db.thread.findUniqueOrThrow({ where: { botId: bot.id } });
      const task = await db.task.create({
        data: {
          userId,
          spaceId,
          botId: bot.id,
          threadId: thread.id,
          prompt: "Sign in",
          status: "queued",
        },
      });
      const run = await db.run.create({
        data: {
          userId,
          spaceId,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          trigger: "user",
          status: "queued",
        },
      });
      runs.login = { runId: seeded.run.id, botId: seeded.bot.id, card: "" };
      runs.other = { runId: run.id, botId: bot.id, card: "" };
      for (const site of ["login", "other"] as const) {
        await runAsSystem("background job run.continue", () =>
          handles.executor.continueRun(runs[site].runId, "test-worker"),
        );
        const message = await db.message.findFirstOrThrow({
          where: { runId: runs[site].runId, role: "bot" },
          orderBy: { seq: "desc" },
        });
        expect(message.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              credential: sites[site],
              replaces: { id: saved.id, origin: www.origin },
            }),
          ]),
        );
        runs[site].card = message.id;
      }
      expect(await db.vaultCredential.findMany({ where: { userId } })).toEqual([saved]);

      // Both answered at once, as the apps send them.
      const results = await Promise.all(
        (["login", "other"] as const).map(async (site) => {
          const response = await handles.app.request("/rpc/threads/answer", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "http://127.0.0.1:5173",
              cookie: seeded.cookie,
            },
            body: JSON.stringify({
              json: {
                botId: runs[site].botId,
                runId: runs[site].runId,
                messageId: runs[site].card,
                answer: "",
                fields: [
                  { label: "Username", value: "fake-user", hidden: false },
                  { label: "Password", value: `fake-password-${site}`, hidden: true },
                ],
              },
            }),
          });
          return response.status;
        }),
      );
      expect(results).toEqual([200, 200]);
      // One row, the same one, with the site and value of whichever card was saved last.
      const rows = await db.vaultCredential.findMany({ where: { userId } });
      expect(rows).toEqual([expect.objectContaining({ id: saved.id, name: www.name })]);
      const last = rows[0]!.origin === sites.login.origin ? "login" : "other";
      expect(rows[0]!.origin).toBe(sites[last].origin);
      const value = await new EncryptedSecretStore(resolveEncryptionKey()).load(
        rows[0]!.ciphertext,
        rows[0]!.id,
      );
      expect(value).toContain(`fake-password-${last}`);
      for (const other of ["www", last === "login" ? "other" : "login"]) {
        expect(value).not.toContain(`fake-password-${other}`);
      }
    } finally {
      runtime.mockRestore();
    }
  });

  describe("a sign-in code the site emails to the bot", () => {
    const site = "https://login.example.test";
    const code = "73915864";
    const mail = `Your sign-in code is ${code}.`;
    /** The code as an email may write it apart, which only a code taken from email hides. */
    const spellings = ["7391 5864", "7 3 9 1 5 8 6 4", "7.3.9.1.5.8.6.4", "7391\u00a05864"];
    const requestCode = {
      name: "request_secret",
      args: { label: "Sign-in code", oneTimeCode: { origin: site } },
    };
    type Call = { name: string; args: Record<string, unknown> };
    const describeRuntime = ScriptedAgentRuntime.prototype.describe;

    it("fills it from the bot's inbox once, never showing it, then asks the owner", async () => {
      const run = await codeRun("emailed-code", (results) => [
        { name: "browser_navigate", args: { url: `${site}/verify` } },
        requestCode,
        { name: "browser_snapshot", args: {} },
        () => ({
          name: "browser_act",
          args: { actions: [{ kind: "fill_code", ref: refNamed(results.at(-1)?.result, "Code") }] },
        }),
        // Later mail writes the code apart; every email the run reads hides it however written.
        async () => {
          await run.deliver("news@example-login.test", `Written apart: ${spellings.join(" / ")}.`);
          return { name: "read_email", args: {} };
        },
        async () => ({
          name: "read_email",
          args: {
            id:
              // The site's email came first.
              (
                await db.botEmailMessage.findFirstOrThrow({
                  where: { botId: run.seeded.bot.id },
                  orderBy: { receivedAt: "asc" },
                })
              ).id,
          },
        }),
        // A run takes one emailed code per site: a new code is the owner's to give.
        requestCode,
      ]);
      try {
        const card = await run.pendingCard();
        expect(card?.pendingAsk.oneTimeCode).toEqual({ origin: site });
        expect(await run.deliver("no-reply@example.test")).toMatchObject({ ok: true, saved: true });
        expect(
          await db.botEmailMessage.findFirstOrThrow({ where: { botId: run.seeded.bot.id } }),
        ).toMatchObject({ verified: true });
        // The email answered the card, the run went on, and only the second request is waiting.
        await vi.waitFor(
          async () => {
            const second = await run.pendingCard();
            expect(second?.messageId).toBeDefined();
            expect(second?.messageId).not.toBe(card!.messageId);
            expect(run.results).toHaveLength(8);
          },
          { timeout: 15_000 },
        );
        expect(await db.run.findUniqueOrThrow({ where: { id: run.seeded.run.id } })).toMatchObject({
          status: "waiting_input",
          error: null,
        });
        // The model sees the run pause, then the request answered, and the result of every call.
        expect(run.results.map((entry) => entry.name)).toEqual([
          "browser_navigate",
          "request_secret",
          "request_secret",
          "browser_snapshot",
          "browser_act",
          "read_email",
          "read_email",
          "request_secret",
        ]);
        expect(run.results[1]?.text).toContain("Waiting for protected input");
        expect(run.results[2]?.text).toContain("The code from the email the site sent was entered");
        expect(run.results.find((entry) => entry.name === "browser_act")?.text).toContain(
          '"ok":true',
        );
        expect(run.results[5]?.text).toContain("Your sign-in code is [redacted].");
        expect(run.results[5]?.text).toContain("Written apart: [redacted]");
        for (const written of spellings) expect(run.results[5]?.text).not.toContain(written);
        expect(run.results[6]?.text).toContain("Your sign-in code is [redacted].");
        expect(run.results[7]?.text).toContain("Waiting for protected input");
        // Typed into the field the snapshot named, and spent there.
        const ref = refNamed(run.results[3]?.result, "Code");
        expect(run.typed).toEqual([
          [{ kind: "fill", ref, text: code, field: "code", origin: site }],
        ]);
        expect(
          await db.secret.count({ where: { kind: `run-code-spent:${run.seeded.run.id}` } }),
        ).toBe(1);
        expect(
          await db.externalEffect.count({
            where: { runId: run.seeded.run.id, kind: "emailed_code", status: "taken" },
          }),
        ).toBe(2);
        const [messages, events, effects] = await Promise.all([
          db.message.findMany({ where: { threadId: run.seeded.thread.id } }),
          db.event.findMany({ where: { threadId: run.seeded.thread.id } }),
          db.externalEffect.findMany({ where: { spaceId: run.seeded.me.spaceId } }),
        ]);
        expect(
          JSON.stringify({ results: run.results, seen: run.seen, messages, events, effects }),
        ).not.toContain(code);
      } finally {
        run.restore();
      }
    });

    it("fills it from the owner's connected mail once allowed, once, never shown", async () => {
      const ownerCode = "20240601";
      /** The mailbox's id for a large message that is not the site's. */
      const unrelated = { id: "" };
      /** The site's mail arrives in the owner's own mailbox. */
      const receive = (from: string) =>
        connectedMail.receiveMail(
          run.seeded.me.userId,
          signedEmail(from, run.connectedMailbox().address, mail),
          new Date(),
        );
      const run = await codeRun("emailed-code-connected", (results) => [
        { name: "browser_navigate", args: { url: `${site}/verify` } },
        // The owner has not allowed reading their mail: the card waits for them.
        requestCode,
        { name: "browser_snapshot", args: {} },
        () => ({
          name: "browser_act",
          args: { actions: [{ kind: "fill_code", ref: refNamed(results.at(-1)?.result, "Code") }] },
        }),
        // Now allowed: the site's next mail in their mailbox answers the next request. Beside it
        // lies a far larger message from another sender, whose address only holds the site's
        // name: the mailbox's search matches it too, and it keeps no one from the site's code.
        () => {
          receive("no-reply@example.test");
          unrelated.id = connectedMail.receiveMail(
            run.seeded.me.userId,
            signedEmail(
              "news@example.test.elsewhere.test",
              run.connectedMailbox().address,
              "A long newsletter. ".repeat(200_000),
            ),
            new Date(),
          );
          return requestCode;
        },
        () => ({
          name: "browser_act",
          args: { actions: [{ kind: "fill_code", ref: refNamed(results[3]?.result, "Code") }] },
        }),
        // A run takes one emailed code per site, from whichever mailbox.
        requestCode,
      ]);
      try {
        const { me, bot } = run.seeded;
        const mailbox = run.connectedMailbox();
        // Not on the site's own domain, whose every address could send it signed mail.
        mailbox.address = "owner@example.net";
        receive("no-reply@example.test");
        const card = await run.pendingCard();
        expect(card?.pendingAsk.oneTimeCode).toEqual({ origin: site });
        // Nothing was read from the owner's mailbox.
        expect(connectedMail.executions).toEqual([]);

        await rpc(run.seeded.cookie, "bots/update", { botId: bot.id, connectedMailCodes: true });
        expect(await db.bot.findUniqueOrThrow({ where: { id: bot.id } })).toMatchObject({
          connectedMailCodes: true,
        });
        // The owner types this code themselves; the site then emails the next one.
        await rpc(run.seeded.cookie, "threads/answer", {
          botId: bot.id,
          runId: run.seeded.run.id,
          messageId: card!.messageId,
          answer: ownerCode,
        });
        await vi.waitFor(
          async () => {
            const second = await run.pendingCard();
            expect(second?.messageId).toBeDefined();
            expect(second?.messageId).not.toBe(card!.messageId);
            expect(run.results).toHaveLength(8);
          },
          { timeout: 15_000 },
        );
        expect(run.results.map((entry) => entry.name)).toEqual([
          "browser_navigate",
          "request_secret",
          "request_secret",
          "browser_snapshot",
          "browser_act",
          "request_secret",
          "browser_act",
          "request_secret",
        ]);
        expect(run.results[1]?.text).toContain("Waiting for protected input");
        expect(run.results[2]?.text).not.toContain("the email the site sent");
        expect(run.results[5]?.text).toContain("The code from the email the site sent was entered");
        expect(run.results[7]?.text).toContain("Waiting for protected input");
        // Both codes were typed into the field: the owner's, then the mailbox's.
        const ref = refNamed(run.results[3]?.result, "Code");
        expect(run.typed).toEqual([
          [{ kind: "fill", ref, text: ownerCode, field: "code", origin: site }],
          [{ kind: "fill", ref, text: code, field: "code", origin: site }],
        ]);
        // Only read, by the site's domain, the newest few: never marked or changed.
        const tools = connectedMail.executions.map((execution) => execution.tool);
        expect(new Set(tools)).toEqual(
          new Set(["GMAIL_GET_PROFILE", "GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"]),
        );
        expect(
          connectedMail.executions.find((execution) => execution.tool === "GMAIL_FETCH_EMAILS")
            ?.args,
        ).toMatchObject({
          query: expect.stringMatching(/^from:example\.test after:\d+$/),
          max_results: 5,
        });
        // Each message is asked about before any is fetched, and only the site's are fetched.
        const formats = connectedMail.executions.flatMap(({ args }) =>
          args.format ? [args.format] : [],
        );
        expect(formats[0]).toBe("metadata");
        expect(new Set(formats)).toEqual(new Set(["metadata", "raw"]));
        const fetched = connectedMail.executions.flatMap(({ args }) =>
          args.format === "raw" ? [args.message_id] : [],
        );
        expect(unrelated.id).not.toBe("");
        expect(fetched).not.toContain(unrelated.id);
        expect(fetched.length).toBeGreaterThan(0);
        expect(
          mailbox.messages
            .filter((message) => message.sender === "no-reply@example.test")
            .map((message) => message.labelIds),
        ).toEqual([
          ["INBOX", "UNREAD"],
          ["INBOX", "UNREAD"],
        ]);
        // The message is claimed for this run, with the site's one code for the run.
        expect(
          await db.externalEffect.findMany({
            where: { runId: run.seeded.run.id, kind: "emailed_code", status: "taken" },
            select: { idempotencyKey: true },
          }),
        ).toEqual(
          expect.arrayContaining([
            { idempotencyKey: `emailed-code:run:${run.seeded.run.id}:example.test` },
            { idempotencyKey: expect.stringMatching(/^emailed-code:message:/) },
          ]),
        );
        const [messages, events, effects] = await Promise.all([
          db.message.findMany({ where: { threadId: run.seeded.thread.id } }),
          db.event.findMany({ where: { threadId: run.seeded.thread.id } }),
          db.externalEffect.findMany({ where: { spaceId: me.spaceId } }),
        ]);
        expect(
          JSON.stringify({ results: run.results, seen: run.seen, messages, events, effects }),
        ).not.toContain(code);
      } finally {
        run.restore();
      }
    });

    it("leaves the card waiting when the code comes from another site's domain", async () => {
      const run = await codeRun("emailed-code-other", () => [
        { name: "browser_navigate", args: { url: `${site}/verify` } },
        requestCode,
      ]);
      try {
        const card = await run.pendingCard();
        expect(card?.pendingAsk.oneTimeCode).toEqual({ origin: site });
        expect(await run.deliver("no-reply@example-login.test")).toMatchObject({
          ok: true,
          saved: true,
        });
        // Properly signed: only its domain, not the site's, keeps it from answering the card.
        expect(
          await db.botEmailMessage.findFirstOrThrow({ where: { botId: run.seeded.bot.id } }),
        ).toMatchObject({ verified: true });
        expect(await run.pendingCard()).toMatchObject({ messageId: card!.messageId });
        expect(await db.run.findUniqueOrThrow({ where: { id: run.seeded.run.id } })).toMatchObject({
          status: "waiting_input",
        });
        expect(
          await db.externalEffect.count({
            where: { runId: run.seeded.run.id, kind: "emailed_code", status: "taken" },
          }),
        ).toBe(0);
        expect(JSON.stringify(run.results)).not.toContain(code);
      } finally {
        run.restore();
      }
    });

    /**
     * A run of a bot with its own address, on a page of the site, that makes `calls` in order.
     * Its model is handed each result, as a real one is, so the test sees what it would.
     */
    async function codeRun(
      label: string,
      calls: (
        results: Array<{ name: string; result: unknown; text: string }>,
      ) => Array<Call | (() => Call | Promise<Call>)>,
    ) {
      const seen: string[] = [];
      const results: Array<{ name: string; result: unknown; text: string }> = [];
      const typed: unknown[] = [];
      const steps = calls(results);
      let resumeAt = 0;
      const spies = [
        vi.spyOn(ScriptedAgentRuntime.prototype, "describe").mockImplementation(function (
          this: ScriptedAgentRuntime,
        ) {
          const described = describeRuntime.call(this);
          return { ...described, capabilities: { ...described.capabilities, scripted: false } };
        }),
        vi.spyOn(ScriptedAgentRuntime.prototype, "run").mockImplementation(async function* (
          request: AgentRunRequest,
        ): AsyncIterable<AgentRuntimeEvent> {
          seen.push(JSON.stringify({ prompt: request.prompt, history: request.history }));
          // A run that pauses is stopped at its next event; its resumed turn makes the paused
          // call again first, as a model's saved turn does.
          for (let index = resumeAt; index < steps.length; index++) {
            const step = steps[index]!;
            const call = typeof step === "function" ? await step() : step;
            const executionId = `${request.runId}:${index}`;
            yield { type: "tool", ...call, executionId };
            const result = await request.executeTool!(call.name, call.args, executionId);
            results.push({ name: call.name, result, text: JSON.stringify(result) });
            if ((result as { terminate?: boolean } | undefined)?.terminate) resumeAt = index;
          }
          yield { type: "done", text: "Done" };
        }),
        vi.spyOn(FakeBrowserProvider.prototype, "navigate").mockImplementation(async function (
          this: FakeBrowserProvider,
          computer,
          request,
          context,
        ) {
          expect(request.url).toBe(`${site}/verify`);
          return this.sessions
            .get(pageBrowserSessionKey(computer, context))
            .load(
              request.url,
              "<!doctype html><html><head><title>Verify</title></head>" +
                '<body><input aria-label="Code" /></body></html>',
            );
        }),
        vi.spyOn(FakeBrowserProvider.prototype, "act").mockImplementation(async function (
          this: FakeBrowserProvider,
          computer,
          request,
          context,
        ) {
          typed.push(request.actions);
          return this.sessions.get(pageBrowserSessionKey(computer, context)).act(request.actions);
        }),
        // The site's mail server publishes the key its mail is signed with.
        vi.spyOn(dnsPromises, "resolve").mockImplementation((async (name: string, type: string) => {
          if (type === "TXT" && name.startsWith("s1._domainkey.")) return [[dkim.record]];
          throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: "ENOTFOUND" });
        }) as never),
      ];
      const restore = () => {
        for (const spy of spies) spy.mockRestore();
      };
      try {
        const seeded = await seedRun(label, "Sign in to the site");
        const { address } = await rpc<{ address: string }>(
          seeded.cookie,
          "bots/claimEmailAddress",
          { botId: seeded.bot.id, name: `${label}-${stamp}`.toLowerCase().slice(0, 60) },
        );
        // A real model calls its tools itself; this one is connected like any other. Its key is
        // never used: the run's runtime is the one above.
        const modelKey = await new EncryptedSecretStore(resolveEncryptionKey()).put(
          "fake-model-key",
          createAdapterContext(seeded.me, seeded.bot.id, `${label}-model-key`),
        );
        await db.secret.create({
          data: {
            id: modelKey.id,
            userId: seeded.me.userId,
            spaceId: null,
            kind: "model",
            ciphertext: modelKey.ciphertext,
          },
        });
        const credential = await db.userModelCredential.create({
          data: {
            userId: seeded.me.userId,
            provider: "scripted",
            label: "Test model",
            secretId: modelKey.id,
          },
        });
        await db.bot.update({
          where: { id: seeded.bot.id },
          data: { modelProvider: credential.provider, modelId: "scripted" },
        });
        // The owner connected their own mailbox in this Space.
        await db.connection.create({
          data: {
            spaceId: seeded.me.spaceId,
            userId: seeded.me.userId,
            connectorId: "composio",
            provider: "GMAIL",
            providerRef: connectedMail.connect(seeded.me.userId, "GMAIL"),
            displayName: "Mail",
            status: "connected",
          },
        });
        await runAsSystem("background job run.continue", () =>
          handles.executor.continueRun(seeded.run.id, "test-worker"),
        );
        return {
          seeded,
          seen,
          results,
          typed,
          restore,
          pendingCard: () =>
            findPendingAsk(db, { threadId: seeded.thread.id, runId: seeded.run.id }),
          connectedMailbox: () => {
            const mailbox = connectedMail.mailboxFor(seeded.me.userId);
            if (!mailbox) throw new Error("The owner's mailbox was not connected");
            return mailbox;
          },
          /** The site's mail, signed as `from`'s domain, through the relay's inbound route. */
          deliver: async (from: string, text = mail) => {
            const response = await handles.app.request(
              `/api/v1/email/inbound?to=${encodeURIComponent(address)}`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${inboundEmail.secret}`,
                  "content-type": "message/rfc822",
                },
                body: signedEmail(from, address, text),
              },
            );
            expect(response.status).toBe(200);
            return response.json();
          },
        };
      } catch (error) {
        restore();
        throw error;
      }
    }

    const dkim = (() => {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const der = publicKey.export({ type: "spki", format: "der" }).toString("base64");
      return { privateKey, record: `v=DKIM1; k=rsa; p=${der}` };
    })();

    /** Plain-text mail from `from`, DKIM-signed by its domain (relaxed/relaxed, rsa-sha256). */
    function signedEmail(from: string, to: string, text: string): string {
      const domain = from.slice(from.lastIndexOf("@") + 1);
      const headers: Array<[string, string]> = [
        ["From", `Sign-in <${from}>`],
        ["To", to],
        ["Subject", "Your sign-in code"],
        ["Date", new Date().toUTCString()],
        ["Message-ID", `<${randomUUID()}@${domain}>`],
      ];
      const body = `${text}\r\n`;
      const hash = createHash("sha256").update(body).digest("base64");
      const names = headers.map(([name]) => name.toLowerCase()).join(":");
      const tags = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=s1`;
      const fields = `${tags}; h=${names}; bh=${hash}; b=`;
      const canonical = [...headers, ["DKIM-Signature", fields]]
        .map(([name, value]) => `${name!.toLowerCase()}:${value!.replace(/\s+/g, " ").trim()}`)
        .join("\r\n");
      const signature = sign("sha256", Buffer.from(canonical), dkim.privateKey).toString("base64");
      return [
        `DKIM-Signature: ${fields}${signature}`,
        ...headers.map(([name, value]) => `${name}: ${value}`),
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        body,
      ].join("\r\n");
    }

    /** The ref of the page element named `name` in a snapshot result's page tree. */
    function refNamed(value: unknown, name: string): string {
      const tree = (value as { details?: { tree?: string } } | undefined)?.details?.tree;
      const ref = tree?.match(new RegExp(`"${name}" \\[(e\\d+)\\]`))?.[1];
      if (!ref) throw new Error(`No "${name}" in the snapshot: ${tree}`);
      return ref;
    }
  });

  async function seedRun(
    label: string,
    prompt: string,
    runState: {
      status?: string;
      leaseOwner?: string;
      leaseFence?: number;
      leaseExpiresAt?: Date;
      startedAt?: Date;
      completedAt?: Date;
    } = {},
  ) {
    const cookie = await signup(`executor-${label}-${stamp}@rakazo.test`, `Executor ${label}`);
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    const bot = await rpc<{ id: string }>(cookie, "bots/create", {
      name: `Executor ${label}`,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const thread = await db.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const task = await db.task.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId: me.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await db.run.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: me.userId,
        status: runState.status ?? "queued",
        trigger: "user",
        leaseOwner: runState.leaseOwner,
        leaseFence: runState.leaseFence,
        leaseExpiresAt: runState.leaseExpiresAt,
        startedAt: runState.startedAt,
        completedAt: runState.completedAt,
      },
    });
    return { cookie, me, bot, thread, task, run };
  }

  async function signup(email: string, name: string) {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12", name }),
    });
    expect(response.status).toBeLessThan(400);
    const raw = response.headers.get("set-cookie") ?? "";
    const match = raw.match(/better-auth\.session_token=([^;]+)/);
    expect(match?.[1]).toBeTruthy();
    return `better-auth.session_token=${match![1]}`;
  }

  async function rpc<T>(cookie: string, procedure: string, body: unknown = {}): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        cookie,
      },
      body: JSON.stringify({ json: body }),
    });
    const payload = (await response.json()) as { json?: T; error?: { message?: string } };
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message ?? `${procedure} failed (${response.status})`);
    }
    return discardBotIntroFromCreate(handles, cookie, procedure, payload.json as T);
  }
});
