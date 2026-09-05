import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { ScriptedAgentRuntime } from "@rakazo/adapters";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;
const destination = {
  name: "example_api",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
};
const key = "fake-reusable-api-key";

describeIntegration("reusable credential lifecycle", () => {
  let handles: Awaited<ReturnType<typeof import("../../../apps/api/src/app.ts")["createApp"]>>;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-secret-lifecycle-"));
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

  it("saves through the answer API, reuses in later runs, rotates and revokes without model-visible plaintext", async () => {
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
      const seeded = await seedRun("reusable", "Save the API credential");
      await handles.executor.continueRun(seeded.run.id, "test-worker");
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
      });
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
      expect(await handles.prisma.run.findUniqueOrThrow({ where: { id: useRun } })).toMatchObject({
        status: "completed",
        error: null,
      });
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
    return payload.json as T;
  }
});
