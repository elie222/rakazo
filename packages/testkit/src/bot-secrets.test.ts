import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { EncryptedSecretStore, PiAgentRuntime, ScriptedAgentRuntime } from "@rakazo/adapters";
import { answerRunInput, createThreadMessage } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import {
  loadBotCommandEnvironment,
  resolveLoginFill,
  securePastedBotSecret,
} from "../../adapters/src/bot-secrets.js";
import { compactHistory } from "../../adapters/src/history-compaction.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { startModelEmulator } from "./model-emulator.js";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;
const destination = {
  name: "example_api",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
};
const key = "fake-reusable-api-key";

describeIntegration("reusable credential lifecycle", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  const dataDir = mkdtempSync(path.resolve(".secret-lifecycle-"));
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const auth = new Headers(init?.headers).get("Authorization");
    return Response.json({
      authenticated: auth === `Bearer ${key}` || auth === `Bearer ${key}-rotated`,
      echo: auth,
    });
  });

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      encryptionKey: "test-only-credential-lifecycle-encryption-key",
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
      remoteConnectors: {
        fetch,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      },
    });
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
        if (requireApproval) {
          await handles.prisma.actionApprovalRule.create({
            data: {
              spaceId: seeded.me.spaceId,
              createdByUserId: seeded.me.userId,
              effect: "require_approval",
              matchKind: "tool",
              matchValue: "request_secret",
            },
          });
        }
        await handles.executor.continueRun(seeded.run.id, "test-worker");
        const approve = async (runId: string, interruptBeforeCard = false) => {
          if (!requireApproval) return;
          const message = await handles.prisma.message.findFirstOrThrow({
            where: { runId, role: "bot" },
            orderBy: { createdAt: "desc" },
          });
          expect(message.blocks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ approvalEffectId: expect.any(String) }),
            ]),
          );
          if (interruptBeforeCard) {
            // Reproduce a worker stopping after releasing the approved effect to intended,
            // before the protected card transaction commits. No background job is enqueued.
            expect(
              await answerRunInput(handles.prisma, {
                spaceId: seeded.me.spaceId,
                threadId: seeded.thread.id,
                runId,
                messageId: message.id,
                answeredByUserId: seeded.me.userId,
                answer: "allow",
              }),
            ).toBe(true);
            await handles.prisma.externalEffect.updateMany({
              where: { runId, kind: "request_secret", status: "approved" },
              data: { status: "intended" },
            });
            await handles.prisma.run.update({
              where: { id: runId },
              data: {
                status: "running",
                leaseOwner: "interrupted-worker",
                leaseExpiresAt: new Date(Date.now() - 60_000),
              },
            });
            await handles.executor.continueRun(runId, "recovery-worker");
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
              const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: runId } });
              expect(["completed", "waiting_input"]).toContain(run.status);
            },
            { timeout: 15_000 },
          );
        };
        await approve(seeded.run.id);
        const answer = async (runId: string, value: string) => {
          const message = await handles.prisma.message.findFirstOrThrow({
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
              expect(
                await handles.prisma.run.findUniqueOrThrow({ where: { id: runId } }),
              ).toMatchObject({ status: "completed", error: null });
            },
            { timeout: 15_000 },
          );
        };
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
        ).toMatchObject({ status: "waiting_input", error: null });
        // An invalid value rolls back the run transition and leaves the card pending.
        const pending = await handles.prisma.message.findFirstOrThrow({
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
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
        ).toMatchObject({ status: "waiting_input" });
        expect(await handles.prisma.botSecret.count({ where: { botId: seeded.bot.id } })).toBe(0);
        await answer(seeded.run.id, key);
        const stored = await handles.prisma.botSecret.findFirstOrThrow({
          where: { botId: seeded.bot.id },
        });
        expect(stored).toMatchObject({
          ...destination,
          userId: seeded.me.userId,
          spaceId: seeded.me.spaceId,
        });
        expect(stored.ciphertext).toMatch(/^v2:/);
        expect(stored.ciphertext).not.toContain(key);
        expect(
          await handles.prisma.secret.count({ where: { kind: `run-secret:${seeded.run.id}` } }),
        ).toBe(0);

        const nextRun = async (nextCalls: typeof calls) => {
          calls = nextCalls;
          const task = await handles.prisma.task.create({
            data: {
              userId: seeded.me.userId,
              spaceId: seeded.me.spaceId,
              botId: seeded.bot.id,
              threadId: seeded.thread.id,
              prompt: "Use the saved credential",
              status: "queued",
            },
          });
          const run = await handles.prisma.run.create({
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
          await handles.executor.continueRun(run.id, "test-worker");
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
        expect(await handles.prisma.run.findUniqueOrThrow({ where: { id: useRun } })).toMatchObject(
          {
            status: "completed",
            error: null,
          },
        );
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(
          await handles.prisma.externalEffect.findFirstOrThrow({
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
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: rotateRun } }),
        ).toMatchObject({ status: "waiting_input" });
        await approve(rotateRun, true);
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: rotateRun } }),
        ).toMatchObject({ status: "waiting_input" });
        expect(
          await handles.prisma.botSecret.findUniqueOrThrow({ where: { id: stored.id } }),
        ).toMatchObject({ ciphertext: stored.ciphertext });
        await answer(rotateRun, `${key}-rotated`);
        expect(
          await handles.prisma.botSecret.findUniqueOrThrow({ where: { id: stored.id } }),
        ).not.toMatchObject({ ciphertext: stored.ciphertext });
        await nextRun([request]);
        expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get("Authorization")).toBe(
          `Bearer ${key}-rotated`,
        );
        const count = fetch.mock.calls.length;
        await nextRun([{ name: "forget_secret", args: { name: destination.name } }, request]);
        expect(await handles.prisma.botSecret.count({ where: { botId: seeded.bot.id } })).toBe(0);
        expect(fetch).toHaveBeenCalledTimes(count);
        const [messages, events, effects, tasks] = await Promise.all([
          handles.prisma.message.findMany({ where: { threadId: seeded.thread.id } }),
          handles.prisma.event.findMany({ where: { threadId: seeded.thread.id } }),
          handles.prisma.externalEffect.findMany({ where: { spaceId: seeded.me.spaceId } }),
          handles.prisma.task.findMany({ where: { botId: seeded.bot.id } }),
        ]);
        expect(JSON.stringify({ seen, messages, events, effects, tasks })).not.toContain(key);
      } finally {
        runtime.mockRestore();
      }
    },
  );

  it.each(["command", "username", "password"] as const)(
    "secures pasted %s credentials across storage, model turns and memory",
    async (field) => {
      const value = "fake-pasted-credential+/=";
      const name = "bank_code";
      const auth =
        field === "command"
          ? { type: "command" }
          : { type: "login", origin: "https://bank.example.test", field };
      const seeded = await seedRun(`pasted-${field}`, `The bank code is ${value}`);
      const userMessage = await createThreadMessage(handles.prisma, {
        threadId: seeded.thread.id,
        role: "user",
        blocks: [{ kind: "text", text: `The bank code is ${value}; again ${value}` }],
      });
      await createThreadMessage(handles.prisma, {
        threadId: seeded.thread.id,
        role: "user",
        blocks: [{ kind: "text", text: `Remember ${value}` }],
        replyToMessageId: userMessage.id,
        replyQuote: value,
      });
      await handles.prisma.event.create({
        data: {
          spaceId: seeded.me.spaceId,
          botId: seeded.bot.id,
          threadId: seeded.thread.id,
          seq: seeded.thread.nextEventSeq,
          type: "thread.message.created",
          payload: { messageId: userMessage.id, role: "user", blocks: userMessage.blocks },
        },
      });
      await handles.prisma.thread.update({
        where: { id: seeded.thread.id },
        data: {
          nextEventSeq: { increment: 1 },
          historyCompactionSummary: `Bank code ${value}`,
        },
      });
      const doc = await handles.prisma.memoryDocument.create({
        data: {
          spaceId: seeded.me.spaceId,
          userId: seeded.me.userId,
          botId: seeded.bot.id,
          scope: "bot",
          path: "OLD.md",
          content: value,
        },
      });
      await handles.prisma.memoryRevision.create({
        data: {
          documentId: doc.id,
          revision: 1,
          content: value,
          sourceThreadId: seeded.thread.id,
        },
      });
      const noSecret = (request: unknown) =>
        expect(JSON.stringify(request).includes(value)).toBe(false);
      const server = await startModelEmulator({
        steps: [
          {
            expect: (request) => expect(JSON.stringify(request).includes(value)).toBe(true),
            response: {
              type: "tool",
              id: "save",
              name: "secure_pasted_secret",
              arguments: { value, name, auth },
            },
          },
          {
            expect: (request) => {
              noSecret(request);
              const result = request.messages.findLast((message) => message.role === "tool");
              expect(JSON.parse(String(result?.content))).toMatchObject({
                ok: true,
                name,
                replaced: 2,
              });
            },
            response: {
              type: "tool",
              id: "remember",
              name: "remember",
              arguments: { path: "LEAK.md", content: value },
            },
          },
          {
            expect: (request) => {
              noSecret(request);
              expect(JSON.stringify(request.messages)).toContain(
                "Protected credentials cannot be saved to memory.",
              );
            },
            response: {
              type: "tool",
              id: "read",
              name: "read_history",
              arguments: {
                messageId: userMessage.id,
              },
            },
          },
          {
            expect: (request) => {
              noSecret(request);
              expect(
                String(request.messages.findLast((message) => message.role === "tool")?.content),
              ).toContain("[saved as bank_code]");
            },
            response: {
              type: "tool",
              id: "search",
              name: "search_history",
              arguments: { query: "bank" },
            },
          },
          {
            expect: (request) => {
              noSecret(request);
              expect(
                String(request.messages.findLast((message) => message.role === "tool")?.content),
              ).toContain("[saved as bank_code]");
            },
            response: { type: "text", text: "Saved" },
          },
          {
            expect: noSecret,
            response: {
              type: "tool",
              id: "remember-later",
              name: "remember",
              arguments: { path: "LATER.md", content: value },
            },
          },
          { expect: noSecret, response: { type: "text", text: "Done" } },
          {
            expect: (request) => {
              noSecret(request);
              expect(JSON.stringify(request.messages)).toContain("[saved as bank_code]");
            },
            response: { type: "text", text: "The bank credential is saved as bank_code." },
          },
        ],
      });
      await rpc(seeded.cookie, "models/connect", {
        provider: server.model.provider,
        modelId: server.model.id,
        baseUrl: server.baseUrl,
        apiKey: "local",
        contextWindow: 160_000,
        maxTokens: 4096,
      });
      await rpc(seeded.cookie, "bots/update", {
        botId: seeded.bot.id,
        modelProvider: server.model.provider,
        modelId: server.model.id,
      });
      const sessionRoot = path.join(dataDir, seeded.bot.id, "sessions");
      const runtime = new PiAgentRuntime({ sessionRoot });
      const descriptor = handles.runtime.describe();
      const describeSpy = vi.spyOn(handles.runtime, "describe").mockReturnValue({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, scripted: false },
      });
      const runSpy = vi
        .spyOn(handles.runtime, "run")
        .mockImplementation((request, context) =>
          runtime.run({ ...request, model: { ...request.model, ...server.model } }, context),
        );
      try {
        await handles.executor.continueRun(seeded.run.id, "test-worker");
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
        ).toMatchObject({ status: "completed", error: null });
        const stored = await handles.prisma.botSecret.findFirstOrThrow({
          where: { botId: seeded.bot.id, name },
        });
        expect(stored.ciphertext).toMatch(/^v2:/);
        expect(stored.ciphertext.includes(value)).toBe(false);
        const store = new EncryptedSecretStore("test-only-credential-lifecycle-encryption-key");
        const scope = {
          userId: seeded.me.userId,
          spaceId: seeded.me.spaceId,
          botId: seeded.bot.id,
        };
        if (field === "command") {
          expect(
            (await loadBotCommandEnvironment(handles.prisma, store, scope)).BANK_CODE === value,
          ).toBe(true);
        } else {
          const fill = await resolveLoginFill({
            prisma: handles.prisma,
            secretStore: store,
            scope,
            name,
            field,
          });
          expect("text" in fill && fill.text === value).toBe(true);
          expect(fill).toMatchObject({ origin: "https://bank.example.test" });
        }
        const message = await handles.prisma.message.findUniqueOrThrow({
          where: { id: userMessage.id },
        });
        expect(message.blocks).toEqual([
          {
            kind: "text",
            text: "The bank code is [saved as bank_code]; again [saved as bank_code]",
          },
        ]);
        const task = await handles.prisma.task.create({
          data: {
            ...scope,
            threadId: seeded.thread.id,
            prompt: "Use the saved credential",
            status: "queued",
          },
        });
        const run = await handles.prisma.run.create({
          data: {
            ...scope,
            threadId: seeded.thread.id,
            taskId: task.id,
            trigger: "user",
            status: "queued",
          },
        });
        await handles.executor.continueRun(run.id, "test-worker");
        await compactHistory(
          {
            prisma: handles.prisma,
            runtime,
            jobs: { enqueue: vi.fn() },
            memoryProviders: { resolve: async () => null },
            resolveModel: async () => ({
              ...server.model,
              contextWindow: 160_000,
              maxTokens: 4096,
            }),
          },
          seeded.thread.id,
        );
        server.assertComplete();
        const files = await readdir(sessionRoot, { recursive: true });
        for (const file of files.filter((file) => file.endsWith(".jsonl"))) {
          expect((await readFile(path.join(sessionRoot, file), "utf8")).includes(value)).toBe(
            false,
          );
        }
        expect(
          await handles.prisma.memoryDocument.count({
            where: { botId: seeded.bot.id, path: { in: ["LEAK.md", "LATER.md"] } },
          }),
        ).toBe(0);
        const persisted = await Promise.all([
          handles.prisma.message.findMany({ where: { threadId: seeded.thread.id } }),
          handles.prisma.event.findMany({ where: { threadId: seeded.thread.id } }),
          handles.prisma.task.findMany({ where: { threadId: seeded.thread.id } }),
          handles.prisma.thread.findUnique({ where: { id: seeded.thread.id } }),
          handles.prisma.memoryDocument.findMany({ where: { botId: seeded.bot.id } }),
          handles.prisma.memoryRevision.findMany({ where: { documentId: doc.id } }),
          handles.prisma.externalEffect.findMany({
            where: { runId: { in: [run.id, seeded.run.id] } },
          }),
        ]);
        noSecret(persisted);
        const replacement = "fake-replacement-credential";
        await createThreadMessage(handles.prisma, {
          threadId: seeded.thread.id,
          role: "user",
          blocks: [{ kind: "text", text: replacement }],
        });
        const nextField = field === "username" ? "password" : "username";
        const saved = await securePastedBotSecret({
          prisma: handles.prisma,
          secretStore: store,
          scope,
          threadId: seeded.thread.id,
          runId: run.id,
          registerRedactions: vi.fn(),
          args: {
            name,
            value: replacement,
            auth: field === "command" ? auth : { ...auth, field: nextField },
          },
        });
        expect(saved).toMatchObject({ ok: true, replaced: 1 });
        const replaced = await handles.prisma.botSecret.findFirstOrThrow({
          where: { botId: seeded.bot.id, name },
        });
        expect(replaced.id).toBe(stored.id);
        expect(replaced.ciphertext).not.toBe(stored.ciphertext);
        if (field === "command") {
          expect(
            (await loadBotCommandEnvironment(handles.prisma, store, scope)).BANK_CODE ===
              replacement,
          ).toBe(true);
        } else {
          for (const [loginField, expected] of [
            [field, value],
            [nextField, replacement],
          ] as const) {
            const filled = await resolveLoginFill({
              prisma: handles.prisma,
              secretStore: store,
              scope,
              name,
              field: loginField,
            });
            expect("text" in filled && filled.text === expected).toBe(true);
          }
        }
      } finally {
        runSpy.mockRestore();
        describeSpy.mockRestore();
        await server.close();
      }
    },
  );

  it.each(["absent", "bot", "stale", "another-thread", "metadata"])(
    "rejects a value from %s without saving or rewriting",
    async (source) => {
      const value = source === "metadata" ? "text" : "fake-unprovided-credential";
      const seeded = await seedRun(`pasted-${source}`, "Save the credential");
      let originalId: string | undefined;
      if (source !== "absent") {
        const other =
          source === "another-thread"
            ? (await seedRun("pasted-other-source", "No credential here")).thread
            : seeded.thread;
        const original = await createThreadMessage(handles.prisma, {
          threadId: other.id,
          role: source === "bot" ? "bot" : "user",
          blocks: [{ kind: "text", text: source === "metadata" ? "No credential here" : value }],
        });
        originalId = original.id;
        if (source === "stale")
          for (let index = 0; index < 20; index += 1) {
            await createThreadMessage(handles.prisma, {
              threadId: seeded.thread.id,
              role: "user",
              blocks: [{ kind: "text", text: "Later message" }],
            });
          }
      }
      const runtime = vi
        .spyOn(ScriptedAgentRuntime.prototype, "run")
        .mockImplementation(async function* (request): AsyncIterable<AgentRuntimeEvent> {
          yield {
            type: "tool",
            name: "secure_pasted_secret",
            executionId: `${request.runId}:save`,
            args: {
              value,
              name: "missing_code",
              auth: { type: "command" },
            },
          };
          yield { type: "done", text: "Done" };
        });
      try {
        await handles.executor.continueRun(seeded.run.id, "test-worker");
        expect(await handles.prisma.botSecret.count({ where: { botId: seeded.bot.id } })).toBe(0);
        const audits = await handles.prisma.event.findMany({
          where: { runId: seeded.run.id, type: "agent.tool.completed" },
        });
        expect(JSON.stringify(audits)).toContain("recent user message");
        if (originalId)
          expect(
            (await handles.prisma.message.findUniqueOrThrow({ where: { id: originalId } })).blocks,
          ).toEqual([{ kind: "text", text: source === "metadata" ? "No credential here" : value }]);
      } finally {
        runtime.mockRestore();
      }
    },
  );

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
    const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const task = await handles.prisma.task.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId: me.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await handles.prisma.run.create({
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
