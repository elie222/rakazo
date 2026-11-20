import { describe, expect, it, vi } from "vitest";
import {
  connectionCleanupJob,
  connectionCleanupJobKey,
  dispatchBackgroundJob,
  HISTORY_COMPACT_MAX_ATTEMPTS,
  historyCompactJob,
  historyCompactJobKey,
  MACHINE_CLEANUP_MAX_ATTEMPTS,
  MESSAGING_INBOUND_SETTLE_MAX_ATTACHMENTS,
  MESSAGING_INBOUND_SETTLE_MAX_ATTEMPTS,
  MESSAGING_SEND_MAX_ATTEMPTS,
  machineCleanupJob,
  machineCleanupJobKey,
  memoryPurgeHistoryJob,
  memoryRetainTurnJob,
  messagingInboundSettleJob,
  messagingInboundSettleJobKey,
  messagingSendJob,
  parseBackgroundJob,
  RetryJobLaterError,
  routineRetryJob,
  teamChatAmbientJob,
  teamChatEngageJob,
} from "./background-jobs.js";
import type { BackgroundJobHandlers } from "./types.js";

function handlers(): BackgroundJobHandlers {
  return {
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "routine.retry": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "run.forget-secrets": vi.fn(async () => undefined),
    "approval.expire": vi.fn(async () => undefined),
    "call.expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "memory.retain-turn": vi.fn(async () => undefined),
    "memory.purge-history": vi.fn(async () => undefined),
    "messaging.send": vi.fn(async () => undefined),
    "messaging.inbound_settle": vi.fn(async () => undefined),
    "messaging.reply": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "messaging.progress": vi.fn(async () => undefined),
    "secret.cleanup": vi.fn(async () => undefined),
    "messaging.credential-cleanup": vi.fn(async () => undefined),
    "connection.cleanup": vi.fn(async () => undefined),
    "computer.machine-cleanup": vi.fn(async () => undefined),
    "team_chat.engage": vi.fn(async () => undefined),
    "team_chat.ambient": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
    "meeting.calendar-sync": vi.fn(async () => undefined),
    "meeting.work": vi.fn(async () => undefined),
    "purchase.poll": vi.fn(async () => undefined),
    "media.poll": vi.fn(async () => undefined),
    "push.receipt": vi.fn(async () => undefined),
    "email.lifecycle": vi.fn(async () => undefined),
  };
}

describe("background job contracts", () => {
  it("validates and dispatches captured memory cleanup with native retry limits", async () => {
    const payload = {
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      threadId: "thread-1",
      generations: [2, 3],
      connectionIdentity: "connection-1",
    };
    const job = memoryPurgeHistoryJob(payload);
    expect(job).toMatchObject({ name: "memory.purge-history", payload, maxAttempts: 12 });
    const target = handlers();
    await dispatchBackgroundJob(target, job.name, job.payload);
    expect(target["memory.purge-history"]).toHaveBeenCalledWith(payload);
    expect(() =>
      parseBackgroundJob("memory.purge-history", { ...payload, connectionIdentity: undefined }),
    ).toThrow();
  });

  it("dispatches a chat message's backup job with the attempt it is on", async () => {
    const target = handlers();
    const attempt = { number: 2, max: MESSAGING_SEND_MAX_ATTEMPTS };
    await dispatchBackgroundJob(
      target,
      "messaging.send",
      { outboundId: "out-1" },
      undefined,
      attempt,
    );
    expect(target["messaging.send"]).toHaveBeenCalledWith(
      { outboundId: "out-1" },
      undefined,
      attempt,
    );
    const due = new Date("2026-08-15T12:01:30.000Z");
    expect(messagingSendJob("out-1", due)).toEqual({
      name: "messaging.send",
      payload: { outboundId: "out-1" },
      availableAt: due,
      replaceKey: "messaging.send:out-1",
      maxAttempts: MESSAGING_SEND_MAX_ATTEMPTS,
    });
  });

  it("keys team-chat jobs per message and queues ambient decisions per conversation", () => {
    const due = new Date("2026-08-15T12:02:00.000Z");
    expect(teamChatEngageJob("message-1", due)).toEqual({
      name: "team_chat.engage",
      payload: { externalMessageId: "message-1" },
      availableAt: due,
      replaceKey: "team_chat.engage:message-1",
    });
    expect(teamChatAmbientJob("conversation-1", due)).toMatchObject({
      replaceKey: "team_chat.ambient:conversation-1",
      queueName: "team_chat.ambient:conversation-1",
    });
  });

  it("queues one sender's inbound settling in order and keys it to the message", async () => {
    const due = new Date("2026-11-17T12:31:00.000Z");
    const payload = {
      provider: "chat",
      handle: "message:1",
      identityId: "identity-1",
      spaceId: "space-1",
      botId: "bot-1",
      receivedAt: due.getTime(),
      text: "make a short of these",
      attachments: [{ name: "clip.mov", mimeType: "video/quicktime" }],
    };
    expect(messagingInboundSettleJob(payload, due)).toStrictEqual({
      name: "messaging.inbound_settle",
      payload,
      availableAt: due,
      replaceKey: messagingInboundSettleJobKey("chat", "message:1"),
      queueName: "messaging.inbound:identity-1",
      maxAttempts: MESSAGING_INBOUND_SETTLE_MAX_ATTEMPTS,
    });
    // A handle may contain the separator; the key keeps provider and handle apart.
    expect(messagingInboundSettleJobKey("chat", "message:1")).not.toBe(
      messagingInboundSettleJobKey("chat:message", "1"),
    );
    const target = handlers();
    await dispatchBackgroundJob(target, "messaging.inbound_settle", payload);
    expect(target["messaging.inbound_settle"]).toHaveBeenCalledWith(payload);
    expect(() =>
      parseBackgroundJob("messaging.inbound_settle", { ...payload, identityId: "" }),
    ).toThrow();
  });

  it("reads settle payloads with and without the file sizes", () => {
    const earlier = {
      provider: "chat",
      handle: "message:1",
      identityId: "identity-1",
      spaceId: "space-1",
      botId: "bot-1",
      receivedAt: 0,
      text: "",
      attachments: [{ name: "clip.mov", mimeType: "video/quicktime" }],
    };
    expect(parseBackgroundJob("messaging.inbound_settle", earlier).payload).toStrictEqual(earlier);
    const current = {
      ...earlier,
      attachments: [{ name: "clip.mov", mimeType: "video/quicktime", size: 42 }],
    };
    expect(parseBackgroundJob("messaging.inbound_settle", current).payload).toStrictEqual(current);
    const file = { name: "photo.jpg", mimeType: "image/jpeg" };
    expect(() =>
      parseBackgroundJob("messaging.inbound_settle", {
        ...earlier,
        attachments: Array.from(
          { length: MESSAGING_INBOUND_SETTLE_MAX_ATTACHMENTS + 1 },
          () => file,
        ),
      }),
    ).toThrow();
    expect(() =>
      parseBackgroundJob("messaging.inbound_settle", {
        ...earlier,
        attachments: [{ ...file, size: -1 }],
      }),
    ).toThrow();
  });

  it("carries the earliest time a job asked to be retried", () => {
    const cause = new Error("rate limited");
    const error = new RetryJobLaterError(30_000, { cause });
    expect({ delayMs: error.delayMs, cause: error.cause }).toEqual({ delayMs: 30_000, cause });
  });

  it("validates and dispatches a secret cleanup by reference and kind", async () => {
    const target = handlers();
    const payload = { kind: "secret_row", recordId: "secret-a", ref: "remote-reference" } as const;
    await dispatchBackgroundJob(target, "secret.cleanup", payload);
    expect(target["secret.cleanup"]).toHaveBeenCalledWith(payload);
    const shared = { ...payload, kind: "secret_tables" };
    expect(parseBackgroundJob("secret.cleanup", shared).payload).toEqual(shared);
    expect(() => parseBackgroundJob("secret.cleanup", { ...payload, kind: "unknown" })).toThrow();
    expect(() => parseBackgroundJob("secret.cleanup", { ...payload, recordId: "" })).toThrow();
  });

  it("validates and dispatches retired messaging credential cleanup", async () => {
    const target = handlers();
    const payload = { installationId: "install-a", ref: "encrypted-reference" };
    await dispatchBackgroundJob(target, "messaging.credential-cleanup", payload);
    expect(target["messaging.credential-cleanup"]).toHaveBeenCalledWith(payload);
    expect(() =>
      parseBackgroundJob("messaging.credential-cleanup", { ref: "encrypted-reference" }),
    ).toThrow();
  });

  it("keys connection cleanup by what it removes, so a retry replaces its backup", async () => {
    const app = {
      spaceId: "space-1",
      userId: "user-1",
      connectorId: "connector-1",
      provider: "mail",
    };
    const request = { ...app, ref: "request-1" };
    const backup = connectionCleanupJob(request, new Date(60_000));
    const retry = connectionCleanupJob(request);
    expect(backup).toMatchObject({ payload: request, availableAt: new Date(60_000) });
    expect(retry).not.toHaveProperty("availableAt");
    expect(retry.replaceKey).toBe(backup.replaceKey);
    expect(connectionCleanupJobKey(app)).not.toBe(backup.replaceKey);

    const target = handlers();
    await dispatchBackgroundJob(target, "connection.cleanup", app);
    expect(target["connection.cleanup"]).toHaveBeenCalledWith(app);
    expect(() => parseBackgroundJob("connection.cleanup", { ...app, userId: "" })).toThrow();
  });

  it("keys a machine's cleanup by provider and machine, so a new delete time replaces the old", async () => {
    const machine = { provider: "provider-a", machineId: "machine-1", homeKey: "home-1" };
    const backup = machineCleanupJob(machine, new Date(960_000));
    const now = machineCleanupJob({ provider: "provider-a", machineId: "machine-1" }, new Date(0));
    expect(backup).toMatchObject({
      payload: machine,
      availableAt: new Date(960_000),
      maxAttempts: MACHINE_CLEANUP_MAX_ATTEMPTS,
    });
    expect(now.replaceKey).toBe(backup.replaceKey);
    expect(backup.replaceKey).toBe(machineCleanupJobKey("provider-a", "machine-1"));
    expect(machineCleanupJobKey("provider-a", "machine-2")).not.toBe(backup.replaceKey);
    expect(machineCleanupJobKey("provider-b", "machine-1")).not.toBe(backup.replaceKey);

    const target = handlers();
    await dispatchBackgroundJob(target, "computer.machine-cleanup", machine);
    expect(target["computer.machine-cleanup"]).toHaveBeenCalledWith(machine);
    expect(() =>
      parseBackgroundJob("computer.machine-cleanup", { provider: "provider-a", machineId: "" }),
    ).toThrow();
  });

  it("validates and dispatches a typed job", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "routine.wakeup", {
      routineId: "routine-1",
      scheduledFor: "2026-08-15T12:00:00.000Z",
    });
    expect(target["routine.wakeup"]).toHaveBeenCalledWith({
      routineId: "routine-1",
      scheduledFor: "2026-08-15T12:00:00.000Z",
    });
  });

  it("validates and dispatches a routine retry keyed to the failed run", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "routine.retry", { runId: "run-1" });
    expect(target["routine.retry"]).toHaveBeenCalledWith({ runId: "run-1" });
    expect(() => parseBackgroundJob("routine.retry", { runId: "" })).toThrow();
    const availableAt = new Date("2026-08-15T12:12:00.000Z");
    expect(routineRetryJob("run-1", availableAt)).toEqual({
      name: "routine.retry",
      payload: { runId: "run-1" },
      availableAt,
      replaceKey: "routine.retry:run-1",
    });
  });

  it("rejects unknown names and malformed deliveries", () => {
    expect(() => parseBackgroundJob("unknown", {})).toThrow("Unknown background job");
    expect(() =>
      parseBackgroundJob("routine.wakeup", {
        routineId: "routine-1",
        scheduledFor: "not-a-date",
      }),
    ).toThrow();
    expect(() => parseBackgroundJob("run.continue", { runId: "" })).toThrow();
    expect(() =>
      parseBackgroundJob("computer.control-expire", {
        computerId: "computer-1",
        leaseId: "",
      }),
    ).toThrow();
  });
});

describe("memoryRetainTurnJob", () => {
  it("retains the whole completed turn under a stable job key", () => {
    expect(memoryRetainTurnJob("run-1", ["m-1"])).toEqual({
      name: "memory.retain-turn",
      payload: { runId: "run-1", messageIds: ["m-1"] },
      replaceKey: "memory.retain-turn:run-1",
      maxAttempts: 4,
    });
  });

  it("schedules checks under a separate stable cleanup key", () => {
    const availableAt = new Date("2026-11-11T12:00:05.000Z");
    const pending = {
      token: "op-1",
      generation: 3,
      checks: 2,
      connectionIdentity: "connection-1",
      source: { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" },
    };
    expect(memoryRetainTurnJob("run-1", [], { pending, availableAt })).toEqual({
      name: "memory.retain-turn",
      payload: { runId: "run-1", pending },
      replaceKey: "memory.retain-turn:run-1:settle",
      availableAt,
      maxAttempts: 4,
    });
    const recovery = memoryRetainTurnJob("run-1", [], {
      pending: { ...pending, token: undefined, unconfirmed: true },
    });
    expect(recovery.replaceKey).toBe("memory.retain-turn:run-1:recover");
    expect(
      new Set([
        memoryRetainTurnJob("run-1").replaceKey,
        memoryRetainTurnJob("run-1", [], { pending }).replaceKey,
        recovery.replaceKey,
      ]).size,
    ).toBe(3);
  });

  it("parses retention and pending-operation payloads", () => {
    expect(parseBackgroundJob("memory.retain-turn", { runId: "run-1" }).payload).toEqual({
      runId: "run-1",
    });
    const pending = {
      token: "op-1",
      generation: 3,
      checks: 0,
      connectionIdentity: "connection-1",
      source: { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" },
    };
    expect(parseBackgroundJob("memory.retain-turn", { runId: "run-1", pending }).payload).toEqual({
      runId: "run-1",
      pending,
    });
    const unconfirmed = { ...pending, token: undefined, unconfirmed: true as const };
    expect(
      parseBackgroundJob("memory.retain-turn", { runId: "run-1", pending: unconfirmed }).payload,
    ).toEqual({ runId: "run-1", pending: unconfirmed });
    // A stored turn whose post-clear purge failed has no token left to poll.
    const purgeOnly = { ...pending, token: undefined };
    expect(
      parseBackgroundJob("memory.retain-turn", { runId: "run-1", pending: purgeOnly }).payload,
    ).toEqual({ runId: "run-1", pending: purgeOnly });
    expect(() =>
      parseBackgroundJob("memory.retain-turn", {
        runId: "run-1",
        pending: { ...pending, checks: -1 },
      }),
    ).toThrow();
  });
});

describe("historyCompactJob", () => {
  it("builds a job with a replace key scoped to the thread", () => {
    expect(historyCompactJob("thread-1")).toEqual({
      name: "history.compact",
      payload: { threadId: "thread-1" },
      replaceKey: historyCompactJobKey("thread-1"),
      maxAttempts: HISTORY_COMPACT_MAX_ATTEMPTS,
    });
  });

  it("caps attempts below the queue default so a stuck thread cannot storm", () => {
    expect(HISTORY_COMPACT_MAX_ATTEMPTS).toBeLessThan(25);
  });

  it("keys different threads differently", () => {
    expect(historyCompactJobKey("thread-1")).not.toBe(historyCompactJobKey("thread-2"));
  });
});
