import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { SAVED_LOGIN_UNREADABLE, VaultItemRefusedError, VaultRetryError } from "@rakazo/adapters";
import type { Actor, ProductEvent } from "@rakazo/contracts";
import { BLOCKED_ITEM_ANSWER, UNCHOSEN_ITEM_ANSWER } from "@rakazo/contracts";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { AnswerTooLongError } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { HEARTBEAT_MS, SESSION_RECHECK_MS } from "../router.js";
import { appHandler, createRouter, handle } from "../router-test-support.js";

describe("thread answer delivery", () => {
  it("accepts a durable answer when the immediate worker wake fails", async () => {
    const answerRunInput = vi.fn().mockResolvedValue(true);
    const enqueue = vi.fn().mockRejectedValue(new Error("job broker unavailable"));
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { answerRunInput },
      jobs: { enqueue },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const response = await handle(
      handler,
      new Request("http://127.0.0.1/rpc/threads/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            botId: "bot-1",
            runId: "run-1",
            messageId: "message-1",
            answer: "Paris",
            clientNonce: "call:call-1:spoken-answer",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(answerRunInput).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        clientNonce: "call:call-1:spoken-answer",
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
    expect(sink.events).toContainEqual(
      expect.objectContaining({ message: "run wake failed", "run.id": "run-1" }),
    );
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });
});

describe("answers the server can't save", () => {
  it.each([
    ["too long", new AnswerTooLongError(), "This answer is too long.", 400],
    // The person blocked bots from the item while the request waited.
    [
      "for a blocked item",
      new VaultItemRefusedError(BLOCKED_ITEM_ANSWER),
      BLOCKED_ITEM_ANSWER,
      400,
    ],
    [
      "for an item chosen for other bots",
      new VaultItemRefusedError(UNCHOSEN_ITEM_ANSWER),
      UNCHOSEN_ITEM_ANSWER,
      400,
    ],
    // The saved login it replaces can't be read for now: a retry may save it.
    [
      "held back by a saved login it can't read",
      new VaultRetryError(SAVED_LOGIN_UNREADABLE),
      SAVED_LOGIN_UNREADABLE,
      409,
    ],
  ])("says why one is %s, without echoing it", async (_, error, message, status) => {
    const answerRunInput = vi.fn().mockRejectedValue(error);
    const enqueue = vi.fn();
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { answerRunInput },
      jobs: { enqueue },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@example.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const answer = `fake-code-${"x".repeat(16_400)}`;
    const response = await handle(
      appHandler(deps),
      new Request("http://127.0.0.1/rpc/threads/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: { botId: "bot-1", runId: "run-1", messageId: "message-1", answer },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(status);
    const body = await response.text();
    expect(body).toContain(message);
    expect(body).not.toContain("fake-code-");
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("secret request dismissal", () => {
  function setup(answered: boolean) {
    const answerRunInput = vi.fn().mockResolvedValue(answered);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { answerRunInput },
      jobs: { enqueue },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "https://web.example.test",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@example.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = appHandler(deps);
    const send = (json: Record<string, unknown>) =>
      handle(
        handler,
        new Request("https://api.example.test/rpc/threads/answer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json: { botId: "bot-1", runId: "run-1", messageId: "message-1", ...json },
          }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
    return { answerRunInput, enqueue, send };
  }

  it("passes a dismissal on as the signed-in user and wakes the run", async () => {
    const h = setup(true);
    const response = await h.send({ answer: "", dismiss: true });

    expect(response.status).toBe(200);
    expect(h.answerRunInput).toHaveBeenCalledWith({
      spaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      messageId: "message-1",
      answeredByUserId: "user-1",
      answer: "",
      clientNonce: undefined,
      fields: undefined,
      username: undefined,
      dismiss: true,
    });
    expect(h.enqueue).toHaveBeenCalledOnce();
  });

  it("passes a login card's fields on with an empty answer", async () => {
    const h = setup(true);
    const fields = [
      { label: "ID number", value: "fake-id-123", hidden: false },
      { label: "Phone number", value: "+1 555 0100", hidden: true },
    ];
    const response = await h.send({ answer: "", fields });

    expect(response.status).toBe(200);
    expect(h.answerRunInput).toHaveBeenCalledWith(expect.objectContaining({ answer: "", fields }));
  });

  it("passes a login answered without saving it on", async () => {
    const h = setup(true);
    const fields = [{ label: "Password", value: "fake-password-1", hidden: true }];
    const response = await h.send({ answer: "", fields, remember: false });

    expect(response.status).toBe(200);
    expect(h.answerRunInput).toHaveBeenCalledWith(
      expect.objectContaining({ fields, remember: false }),
    );
  });

  it("reports a dismissal the card no longer accepts as a conflict", async () => {
    const h = setup(false);
    const response = await h.send({ answer: "", dismiss: true });

    expect(response.status).toBe(409);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["a dismissal with a value", { answer: "example-password", dismiss: true }],
    ["a dismissal with a username", { answer: "", username: "ada", dismiss: true }],
    [
      "a dismissal with fields",
      { answer: "", fields: [{ label: "Code", value: "x", hidden: true }], dismiss: true },
    ],
    [
      "fields with a value in answer",
      { answer: "example-password", fields: [{ label: "Code", value: "x", hidden: true }] },
    ],
    [
      "fields with a username",
      { answer: "", username: "ada", fields: [{ label: "Code", value: "x", hidden: true }] },
    ],
    ["fields without hidden", { answer: "", fields: [{ label: "Code", value: "x" }] }],
    ["a dismissal during a call", { answer: "", clientNonce: "call:call-1:x", dismiss: true }],
    ["an empty answer", { answer: "" }],
    ["not saving an answer that isn't a login", { answer: "123456", remember: false }],
    ["not saving a dismissal", { answer: "", dismiss: true, remember: false }],
    [
      "remember true",
      {
        answer: "",
        fields: [{ label: "Password", value: "x", hidden: true }],
        remember: true,
      },
    ],
  ])("rejects %s before it reaches the run", async (_name, json) => {
    const h = setup(true);
    const response = await h.send(json);

    expect(response.status).toBe(400);
    expect(h.answerRunInput).not.toHaveBeenCalled();
  });

  it("reports a credential its destination cannot carry as a bad request", async () => {
    const h = setup(true);
    h.answerRunInput.mockRejectedValue(
      new VaultItemRefusedError("Credential cannot be used with this authentication method"),
    );
    const response = await h.send({ answer: "example\nvalue" });

    expect(response.status).toBe(400);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("Credential cannot be used with this authentication method");
    expect(body).not.toContain("example");
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["an unexpected failure", "database unavailable"],
    // Only the vault's own refusal is the person's to fix, whatever another error says.
    ["one that reads like a refusal", "Invalid credential destination — name: x"],
  ])("keeps %s as a server error", async (_case, message) => {
    const h = setup(true);
    h.answerRunInput.mockRejectedValue(new Error(message));
    const response = await h.send({ answer: "Paris" });

    expect(response.status).toBe(500);
  });
});

describe("thread stream authorization", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function threadStream() {
    vi.useFakeTimers();
    const queued: ProductEvent[] = [];
    let waiting: Deferred<IteratorResult<ProductEvent>> | undefined;
    const follow = {
      next: () => {
        if (queued.length > 0)
          return Promise.resolve({ done: false as const, value: queued.shift()! });
        waiting = deferred();
        return waiting.promise;
      },
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const emit = (seq: number, text: string, extra?: Partial<ProductEvent>) => {
      const event: ProductEvent = {
        id: `event-${seq}`,
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        seq,
        type: "thread.message.created",
        createdAt: new Date().toISOString(),
        payload: { text },
        ...extra,
      };
      if (waiting) {
        waiting.resolve({ done: false, value: event });
        waiting = undefined;
      } else {
        queued.push(event);
      }
    };
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
      run: {
        findUnique: vi.fn().mockResolvedValue({ trigger: "bot_message" }),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { follow: vi.fn(() => follow) },
      env: { webOrigin: "http://127.0.0.1:5173", screenProxySecret: "fake-test-secret" },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const stillAuthorized = vi.fn().mockResolvedValue(true);
    const client = createRouterClient(createRouter(deps), {
      context: { actor, stillAuthorized },
    });
    return { client, emit, follow, stillAuthorized };
  }

  it("stops delivering a busy thread once the session is revoked", async () => {
    const { client, emit, follow, stillAuthorized } = threadStream();
    const stream = await client.threads.subscribe({ botId: "bot-1", cursor: -1 });

    emit(1, "before");
    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 1 } });
    expect(stillAuthorized).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + SESSION_RECHECK_MS);
    emit(2, "still signed in");
    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 2 } });
    expect(stillAuthorized).toHaveBeenCalledTimes(1);

    stillAuthorized.mockResolvedValue(false);
    vi.setSystemTime(Date.now() + SESSION_RECHECK_MS);
    emit(3, "after revocation");
    await expect(stream.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(follow.return).toHaveBeenCalled();
  });

  it("ends an idle stream at its next heartbeat once the session is revoked", async () => {
    const { client, follow, stillAuthorized } = threadStream();
    const stream = await client.threads.subscribe({ botId: "bot-1", cursor: -1 });

    stillAuthorized.mockResolvedValue(false);
    const ended = expect(stream.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await ended;
    expect(follow.return).toHaveBeenCalled();
  });

  it("re-checks authorization before skipping filtered peer events", async () => {
    const { client, emit, follow, stillAuthorized } = threadStream();
    const stream = await client.threads.subscribe({ botId: "bot-1", cursor: -1 });

    emit(1, "before");
    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 1 } });
    expect(stillAuthorized).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + SESSION_RECHECK_MS);
    stillAuthorized.mockResolvedValue(false);
    emit(2, "hidden", { type: "thread.progress", runId: "run-peer", payload: {} });
    const pending = stream.next();
    const outcome = await Promise.race([
      pending.then(
        () => "yielded" as const,
        () => "rejected" as const,
      ),
      (async () => {
        for (let step = 0; step < 30; step++) {
          await Promise.resolve();
          await vi.advanceTimersByTimeAsync(0);
        }
        return "still-open" as const;
      })(),
    ]);
    expect(outcome).toBe("rejected");
    await expect(pending).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(stillAuthorized).toHaveBeenCalledTimes(1);
    expect(follow.return).toHaveBeenCalled();
  });
});

describe("threads.answerCall and threads.declineCall", () => {
  function fixture(
    status = "ringing",
    updated = 1,
    expiresAt = new Date(Date.now() + 45_000).toISOString(),
  ) {
    const appended: { type: string; payload: Record<string, unknown> }[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => []),
      bot: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "bot-1", thread: { id: "thread-1" }, computer: null }),
      },
      message: {
        findUnique: vi.fn().mockResolvedValue({
          id: "message-1",
          botId: "bot-1",
          thread: { spaceId: "space-1" },
          blocks: [
            {
              kind: "call_request",
              callId: "call-1",
              reason: "Send the report",
              opening: "Hi, it's about the report.",
              status,
              expiresAt,
            },
          ],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: updated }),
      },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 2 })) },
      event: {
        create: vi.fn(
          async ({ data }: { data: { type: string; payload: Record<string, unknown> } }) => {
            appended.push(data);
            return { seq: 1 };
          },
        ),
      },
      routine: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "routine-1",
          ...data,
        })),
      },
    };
    const prisma = {
      ...tx,
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaClient;
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const deps = {
      prisma,
      events: {
        notify: vi.fn().mockResolvedValue(undefined),
        append: vi.fn(async (event: { type: string; payload: Record<string, unknown> }) => {
          appended.push(event);
          return { seq: 1 };
        }),
      },
      jobs: { enqueue },
      env: { sandboxProvider: "fake", phoneCallsEnabled: true },
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "space-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));
    const call = (path: string, json: Record<string, unknown>) =>
      handle(
        handler,
        new Request(`http://127.0.0.1/rpc/threads/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId: "bot-1", callId: "call-1", ...json } }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
    return { prisma, appended, enqueue, call };
  }

  it("answers a ringing call with the bot's opening", async () => {
    const { call, appended } = fixture();
    const response = await call("answerCall", {});
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: { opening: "Hi, it's about the report.", reason: "Send the report" },
    });
    expect(appended[0]?.payload).toMatchObject({
      messageId: "message-1",
      blocks: [expect.objectContaining({ status: "answered" })],
    });
  });

  it("refuses to answer a call that is no longer ringing", async () => {
    const { call } = fixture("missed");
    const response = await call("answerCall", {});
    expect(response.status).toBe(409);
  });

  it("marks a declined call without scheduling another", async () => {
    const { call, appended, prisma } = fixture();
    const response = await call("declineCall", { outcome: "declined" });
    expect(response.status).toBe(200);
    expect(appended[0]?.payload).toMatchObject({
      blocks: [expect.objectContaining({ status: "declined" })],
    });
    expect(prisma.routine.create).not.toHaveBeenCalled();
  });

  it("rejects expired answers and records a missed call", async () => {
    const { call, appended } = fixture("ringing", 1, new Date(0).toISOString());
    expect((await call("answerCall", {})).status).toBe(409);
    expect(appended[0]?.payload).toMatchObject({
      blocks: [expect.objectContaining({ status: "missed" })],
    });
  });

  it("checks ownership within the active space", async () => {
    const { call, prisma } = fixture();
    vi.mocked(prisma.bot.findFirst).mockResolvedValue(null);
    expect((await call("answerCall", {})).status).not.toBe(200);
    expect(prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "bot-1", spaceId: "space-1" }),
      }),
    );
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });
});

describe("threads.endCall", () => {
  function fixture(duplicateMarker?: boolean, userSpoke = true) {
    const created: { blocks?: unknown; clientNonce?: string }[] = [];
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => []),
      $executeRaw: vi.fn(async () => 0),
      thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 3, nextEventSeq: 5 }) },
      message: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(userSpoke ? { id: "utterance-1" } : null),
        create: vi.fn(async ({ data }: { data: { blocks: unknown; clientNonce?: string } }) => {
          if (duplicateMarker) throw Object.assign(new Error("unique"), { code: "P2002" });
          created.push({ blocks: data.blocks, clientNonce: data.clientNonce });
          return { id: "message-1" };
        }),
      },
      event: vi.fn(),
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      run: {
        create: vi.fn().mockResolvedValue({ id: "run-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
      },
    };
    tx.event = {
      create: vi.fn(async ({ data }: { data: { type: string; payload: never } }) => {
        events.push({ type: data.type, payload: data.payload });
        return { seq: 4, threadId: "thread-1" };
      }),
    } as never;
    const prisma = {
      bot: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "bot-1", thread: { id: "thread-1" }, computer: null }),
      },
      // No bot-placed call behind this one: only the caller's own hang-up runs.
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      taughtSkill: { findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
    } as unknown as PrismaClient;
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const deps = {
      prisma,
      events: { notify: vi.fn().mockResolvedValue(undefined) },
      jobs: { enqueue },
      env: { sandboxProvider: "fake", phoneCallsEnabled: true },
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "space-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));
    return {
      tx,
      created,
      events,
      enqueue,
      call: (extra: Record<string, unknown> = {}) =>
        handle(
          handler,
          new Request("http://127.0.0.1/rpc/threads/endCall", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: { botId: "bot-1", callId: "call-1", ...extra } }),
          }),
          { prefix: "/rpc", context: { actor } },
        ),
    };
  }

  it("closes the card and queues a call_end run", async () => {
    const { call, created, events, tx, enqueue } = fixture();
    const response = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(created[0]?.blocks).toEqual([
      { kind: "voice_call", callId: "call-1", title: "", farewell: "" },
    ]);
    expect(created[0]?.clientNonce).toBe("call:call-1:marker");
    expect(events.map((event) => event.type)).toEqual([
      "thread.message.created",
      "thread.call.ended",
    ]);
    expect(events[1]?.payload).toMatchObject({
      callId: "call-1",
      title: "",
      messageId: "message-1",
    });
    expect(events[0]?.payload).toMatchObject({ callId: "call-1", messageId: "message-1" });
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "call_end", taskId: "task-1" }),
      }),
    );
    expect(String(tx.run.create.mock.calls[0]?.[0]?.data?.clientNonce)).toMatch(/^call:call-1:/);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("keeps the connected time the caller reported on the card", async () => {
    const { call, created } = fixture();
    const response = await call({ durationSeconds: 83 });
    expect(response.status).toBe(200);
    expect(created[0]?.blocks).toEqual([
      { kind: "voice_call", callId: "call-1", title: "", farewell: "", durationSeconds: 83 },
    ]);
  });

  it("rejects a negative connected time", async () => {
    const { call, created } = fixture();
    const response = await call({ durationSeconds: -1 });
    expect(response.status).toBe(400);
    expect(created).toEqual([]);
  });

  it("is a no-op for a late hang-up with no user call utterance", async () => {
    const { call, created, events, tx, enqueue } = fixture(false, false);
    const response = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(tx.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "thread-1",
          role: "user",
          clientNonce: { startsWith: "call:call-1:" },
        }),
      }),
    );
    expect(created).toEqual([]);
    expect(events).toEqual([]);
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("is a no-op when a concurrent hang-up already wrote the marker", async () => {
    const { call, created, events, tx, enqueue } = fixture(true);
    const response = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(created).toEqual([]);
    expect(events).toEqual([]);
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
