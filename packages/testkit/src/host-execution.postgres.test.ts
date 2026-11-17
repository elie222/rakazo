import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runJobKey } from "@rakazo/adapter-kit";
import type { createApp } from "@rakazo/api/app";
import type { HostFrame, HostStart } from "@rakazo/contracts";
import { computerUsingRuns } from "@rakazo/core";
import { createThreadMessageInTransaction, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { asSystem } from "./system-db.js";

const integration = process.env.VERIFY_DATABASE === "1" ? describe : describe.skip;
integration("desktop-originated runs through the authenticated API", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let db: Awaited<ReturnType<typeof createApp>>["prisma"];
  let cookie: string;
  let actor: { spaceId: string; userId: string };
  let botId: string;
  const email = "host-agent@rakazo.test";
  const root = mkdtempSync(path.join(tmpdir(), "host-product-fixture-"));
  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    app = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir: path.join(root, "app"),
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      deploymentModelConfigured: false,
    });
    db = asSystem(app.prisma);
    const response = await app.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "test-password-12", name: "Host agent fixture" }),
    });
    expect(response.status).toBeLessThan(400);
    cookie = `better-auth.session_token=${response.headers.get("set-cookie")!.match(/better-auth\.session_token=([^;]+)/)![1]}`;
    const me = await rpc<{ spaceId: string; userId: string }>("me");
    actor = { spaceId: me.spaceId, userId: me.userId };
    await db.user.update({ where: { id: actor.userId }, data: { emailVerified: true } });
    botId = (
      await rpc<{ id: string }>("bots/create", {
        name: "Host fixture",
        title: "",
        description: "",
        instructions: "Fixture instructions",
        notifyOnFinish: false,
      })
    ).id;
    vi.spyOn(app.runtime, "run").mockImplementation(() => {
      throw new Error("Desktop work must never reach the server model");
    });
  });
  afterAll(async () => {
    await app?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  async function response(procedure: string, input: unknown = {}, session = cookie) {
    return app.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        cookie: session,
      },
      body: JSON.stringify({ json: input }),
    });
  }
  async function rpc<T = unknown>(procedure: string, input: unknown = {}): Promise<T> {
    const result = await response(procedure, input);
    const body = (await result.json()) as { json: T };
    expect(result.status, JSON.stringify(body)).toBe(200);
    return discardBotIntroFromCreate(app, cookie, procedure, body.json);
  }
  function request(overrides: Partial<HostStart> = {}): HostStart {
    return {
      botId,
      text: "Run on my device",
      clientNonce: randomUUID(),
      token: randomUUID(),
      installationId: "fixture-installation",
      profileId: "fixture-profile",
      revision: 1,
      engineVersion: "fixture-version",
      target: "workspace",
      ...overrides,
    };
  }
  type Grant = {
    runId: string;
    taskId: string;
    threadId: string;
    seq: number;
    token: string;
    generation: string;
    stopped: boolean;
    session?: { id: string; engineVersion: string };
    context: { role: string; content: string }[];
  };
  async function start(input = request()) {
    return rpc<Grant>("executions/host/start", input);
  }
  async function sync(grant: Grant, frames: HostFrame[]) {
    return rpc<{
      after: number;
      stopped: boolean;
      answers: { requestId: string; answer: string }[];
    }>("executions/host/sync", { runId: grant.runId, token: grant.token, frames });
  }

  it("starts immediately, records one message for a retry, and keeps an atomic delayed backup", async () => {
    const input = request();
    const grant = await start(input);
    expect(await start(input)).toMatchObject(grant);
    expect((await db.run.findUniqueOrThrow({ where: { id: grant.runId } })).status).toBe("running");
    expect(
      await db.message.count({
        where: { threadId: grant.threadId, clientNonce: input.clientNonce },
      }),
    ).toBe(1);
    expect(await db.run.count({ where: { id: grant.runId, ...computerUsingRuns() } })).toBe(0);
    const key = runJobKey(grant.runId);
    const backup = await db.$queryRaw<
      { run_at: Date }[]
    >`SELECT run_at FROM graphile_worker.jobs WHERE key = ${key}`;
    expect(backup).toHaveLength(1);
    expect(backup[0]!.run_at.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(
      (await response("executions/host/start", { ...input, text: "Different message" })).status,
    ).toBe(409);
    await runAsSystem("host worker test", () =>
      app.executor.continueRun(grant.runId, "fixture-worker"),
    );
    expect(app.runtime.run).not.toHaveBeenCalled();
    await sync(grant, [{ sequence: 1, event: { type: "cancelled" } }]);
  });

  it("replays only unacknowledged events and requires this desktop's proof for an approval", async () => {
    const input = request();
    const grant = await start(input);
    const frames: HostFrame[] = [
      {
        sequence: 1,
        event: {
          type: "session",
          session: { id: "fixture-session", engineVersion: input.engineVersion },
        },
      },
      { sequence: 2, event: { type: "text", text: "Hello from the native agent" } },
      {
        sequence: 3,
        event: {
          type: "interaction",
          request: {
            id: "fixture-permission",
            kind: "permission",
            title: "Write a file?",
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          },
        },
      },
    ];
    expect(await sync(grant, frames)).toMatchObject({ after: 3, stopped: false });
    expect(await sync(grant, frames)).toMatchObject({ after: 3, stopped: false });
    const ask = await db.nativeInteraction.findFirstOrThrow({ where: { runId: grant.runId } });
    const webAnswer = await response("threads/answer", {
      botId,
      runId: grant.runId,
      messageId: ask.messageId,
      answer: "allow",
    });
    expect(webAnswer.status).toBe(409);
    expect(await webAnswer.text()).toContain("Reply on the desktop that started this task.");
    expect((await db.nativeInteraction.findUniqueOrThrow({ where: { id: ask.id } })).status).toBe(
      "pending",
    );
    expect(
      (
        await response("executions/host/answer", {
          runId: grant.runId,
          token: "wrong-proof-wrong-proof-wrong-proof",
          messageId: ask.messageId,
          answer: "allow",
        })
      ).status,
    ).toBe(403);
    expect(
      await rpc("executions/host/answer", {
        runId: grant.runId,
        token: grant.token,
        messageId: ask.messageId,
        answer: "deny",
      }),
    ).toEqual({ ok: true });
    expect((await sync(grant, [])).answers).toEqual([
      { requestId: "fixture-permission", answer: "deny" },
    ]);
    const terminal: HostFrame[] = [
      {
        sequence: 4,
        event: { type: "interaction_closed", id: "fixture-permission", status: "delivered" },
      },
      { sequence: 5, event: { type: "completed" } },
    ];
    expect(await sync(grant, terminal)).toMatchObject({ after: 5, stopped: true });
    await sync(grant, terminal);
    const messages = await db.message.findMany({ where: { runId: grant.runId, role: "bot" } });
    expect(
      messages.filter((m) => JSON.stringify(m.blocks).includes("Hello from the native agent")),
    ).toHaveLength(1);
    expect((await db.run.findUniqueOrThrow({ where: { id: grant.runId } })).status).toBe(
      "completed",
    );
    const next = await start();
    expect(next.session).toEqual({ id: "fixture-session", engineVersion: input.engineVersion });
    await sync(next, [{ sequence: 1, event: { type: "cancelled" } }]);
  });

  it("rejects gaps, different sessions and other tenant reads", async () => {
    const grant = await start();
    expect(
      (
        await response("executions/host/sync", {
          ...grant,
          frames: [{ sequence: 2, event: { type: "text", text: "gap" } }],
        })
      ).status,
    ).toBe(409);
    expect(
      (await db.hostExecution.findUniqueOrThrow({ where: { runId: grant.runId } })).lastSequence,
    ).toBe(0);
    expect(
      await runAsTenant({ ...actor, userId: "another-fixture-user" }, () =>
        app.prisma.hostExecution.findUnique({ where: { runId: grant.runId } }),
      ),
    ).toBe(null);
    const login = await app.app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "test-password-12" }),
    });
    const otherCookie = `better-auth.session_token=${login.headers.get("set-cookie")!.match(/better-auth\.session_token=([^;]+)/)![1]}`;
    expect(
      (
        await response(
          "executions/host/sync",
          { runId: grant.runId, token: grant.token, frames: [] },
          otherCookie,
        )
      ).status,
    ).toBe(403);
    await sync(grant, [{ sequence: 1, event: { type: "cancelled" } }]);
  });

  it("expires disconnected work without invoking any model or replaying its prompt", async () => {
    const grant = await start();
    await db.run.update({ where: { id: grant.runId }, data: { leaseExpiresAt: new Date(0) } });
    await runAsSystem("expire a host test run", () =>
      app.executor.continueRun(grant.runId, "fixture-worker"),
    );
    expect((await db.run.findUniqueOrThrow({ where: { id: grant.runId } })).status).toBe("failed");
    expect(app.runtime.run).not.toHaveBeenCalled();
    expect((await sync(grant, [])).stopped).toBe(true);
  });

  it("runs remote workspace tools once and rejects a changed computer", async () => {
    const grant = await start(request({ target: "computer" }));
    expect(await db.run.count({ where: { id: grant.runId, ...computerUsingRuns() } })).toBe(1);
    const write = vi.spyOn(app.sandbox, "writeFile");
    const call = {
      runId: grant.runId,
      token: grant.token,
      id: "fixture-write",
      call: {
        name: "computer_write_file",
        input: { path: "host-fixture.txt", text: "Remote fixture result" },
      },
    };
    const first = await rpc("executions/host/tool", call);
    expect(first).toEqual({ result: '{"written":true}' });
    const writes = write.mock.calls.length;
    expect(await rpc("executions/host/tool", call)).toEqual(first);
    expect(write.mock.calls).toHaveLength(writes);
    expect(
      (
        await response("executions/host/tool", {
          ...call,
          call: { ...call.call, input: { ...call.call.input, text: "Different" } },
        })
      ).status,
    ).toBe(409);
    const read = await rpc<{ result: string }>("executions/host/tool", {
      ...call,
      id: "fixture-read",
      call: { name: "computer_read_file", input: { path: "host-fixture.txt" } },
    });
    expect(JSON.parse(read.result)).toEqual({ text: "Remote fixture result" });
    const attach = {
      ...call,
      id: "fixture-attach",
      call: { name: "computer_attach_file", input: { path: "host-fixture.txt" } },
    };
    const attachment = await rpc<{ result: string }>("executions/host/tool", attach);
    const artifactId = JSON.parse(attachment.result).artifactId;
    expect(await rpc("executions/host/tool", attach)).toEqual(attachment);
    expect(await db.artifact.count({ where: { runId: grant.runId } })).toBe(1);
    expect(
      await db.message.count({
        where: { runId: grant.runId, blocks: { array_contains: [{ kind: "file", artifactId }] } },
      }),
    ).toBe(1);
    await db.bot.update({ where: { id: botId }, data: { computerSwitching: true } });
    expect(
      (await response("executions/host/tool", { ...call, id: "changed-computer" })).status,
    ).toBe(409);
    await db.bot.update({ where: { id: botId }, data: { computerSwitching: false } });
    await sync(grant, [{ sequence: 1, event: { type: "completed" } }]);
    expect(
      await db.computerExecutionLease.count({
        where: { runId: grant.runId, expiresAt: { gt: new Date() } },
      }),
    ).toBe(0);
    write.mockRestore();
  });

  it("expires approvals and preserves acknowledged partial output when stopped from another surface", async () => {
    const grant = await start();
    await sync(grant, [
      { sequence: 1, event: { type: "text", text: "Acknowledged partial result" } },
      {
        sequence: 2,
        event: {
          type: "interaction",
          request: {
            id: "stop-permission",
            kind: "permission",
            title: "Run a command?",
            actions: [{ id: "deny", label: "Deny" }],
          },
        },
      },
    ]);
    await rpc("threads/stop", { botId });
    expect((await sync(grant, [])).stopped).toBe(true);
    await sync(grant, []);
    expect(
      (
        await db.nativeInteraction.findUniqueOrThrow({
          where: { runId_requestId: { runId: grant.runId, requestId: "stop-permission" } },
        })
      ).status,
    ).toBe("expired");
    const messages = await db.message.findMany({ where: { runId: grant.runId, role: "bot" } });
    expect(
      messages.filter((message) =>
        JSON.stringify(message.blocks).includes("Acknowledged partial result"),
      ),
    ).toHaveLength(1);
    expect(
      await rpc("executions/host/answer", {
        runId: grant.runId,
        token: grant.token,
        messageId: messages[0]!.id,
        answer: "deny",
      }),
    ).toEqual({ ok: false });
  });

  it("adds intervening messages on resume and forgets native sessions when the conversation is cleared", async () => {
    const grant = await start();
    await sync(grant, [
      {
        sequence: 1,
        event: {
          type: "session",
          session: { id: "context-session", engineVersion: "fixture-version" },
        },
      },
      { sequence: 2, event: { type: "text", text: "First reply" } },
      { sequence: 3, event: { type: "completed" } },
    ]);
    await db.$transaction((tx) =>
      createThreadMessageInTransaction(tx, {
        threadId: grant.threadId,
        role: "user",
        authorUserId: actor.userId,
        blocks: [{ kind: "text", text: "Intervening server message" }],
      }),
    );
    const next = await start();
    expect(next.session?.id).toBe("context-session");
    expect(next.context).toEqual([{ role: "user", content: "Intervening server message" }]);
    await sync(next, [{ sequence: 1, event: { type: "cancelled" } }]);
    await rpc("threads/clear", { botId });
    const fresh = await start();
    expect(fresh.session).toBeUndefined();
    expect(fresh.context).toEqual([]);
    await sync(fresh, [{ sequence: 1, event: { type: "cancelled" } }]);
  });
  it("keeps a cleared conversation empty when an old run syncs", async () => {
    const input = request();
    const grant = await start(input);
    await sync(grant, [{ sequence: 1, event: { type: "text", text: "Old cleared output" } }]);
    await rpc("threads/clear", { botId });
    expect(await db.message.count({ where: { threadId: grant.threadId } })).toBe(0);
    expect((await sync(grant, [])).stopped).toBe(true);
    expect(await db.message.count({ where: { threadId: grant.threadId } })).toBe(0);
    expect((await response("executions/host/start", input)).status).toBe(409);
    expect((await sync(grant, [])).stopped).toBe(true);
    expect(await db.message.count({ where: { threadId: grant.threadId } })).toBe(0);
  });

  it("uses the locked generation when clear overtakes a starting run", async () => {
    const previous = await start();
    await sync(previous, [
      {
        sequence: 1,
        event: {
          type: "session",
          session: { id: "before-clear-session", engineVersion: "fixture-version" },
        },
      },
      { sequence: 2, event: { type: "completed" } },
    ]);
    const findFirst = app.prisma.thread.findFirst.bind(app.prisma.thread);
    let release!: () => void;
    let read!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed = new Promise<void>((resolve) => {
      read = resolve;
    });
    const spy = vi.spyOn(app.prisma.thread, "findFirst").mockImplementationOnce((args) => {
      const query = findFirst(args);
      const then = query.then.bind(query);
      // biome-ignore lint/suspicious/noThenProperty: delay the real Prisma thenable after its read.
      query.then = (fulfilled, rejected) =>
        then(async (thread) => {
          read();
          await barrier;
          return thread;
        }).then(fulfilled, rejected);
      return query;
    });
    const pending = start();
    try {
      await observed;
      await rpc("threads/clear", { botId });
    } finally {
      release();
      spy.mockRestore();
    }
    const grant = await pending;
    try {
      expect(grant.session).toBeUndefined();
    } finally {
      await sync(grant, [{ sequence: 1, event: { type: "cancelled" } }]);
    }
  });
});
