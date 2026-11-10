import type { MessagingInboundMessage } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { TeamChatBridge } from "./team-chat-bridge.js";
import {
  PendingTeamChatInbound,
  prefersTeamChatSurface,
  settleWithTimeout,
  TeamChatStartupRetries,
} from "./team-chat-startup.js";

function message(overrides: Partial<MessagingInboundMessage> = {}): MessagingInboundMessage {
  return {
    type: "message",
    provider: "slack",
    handle: "Ev-1",
    threadId: "C-1",
    isDirect: true,
    from: "U-1",
    fromLabel: "Ada",
    channelName: null,
    participants: [],
    content: "hello",
    mediaUrl: null,
    workspaceId: "T-1",
    conversationKey: "im:U-1",
    kind: "direct",
    ...overrides,
  };
}

describe("team chat startup helpers", () => {
  it("prefers TeamChat for configured workspace surfaces even before the bridge is ready", () => {
    expect(prefersTeamChatSurface(message({ isDirect: false }), "bot-1")).toBe(true);
    expect(prefersTeamChatSurface(message(), "bot-1")).toBe(false);
    expect(
      prefersTeamChatSurface(message({ provider: "sendblue", workspaceId: undefined }), "bot-1"),
    ).toBe(false);
    expect(prefersTeamChatSurface(message(), undefined)).toBe(false);
  });

  it("settles buffered TeamChat inbound only after the bridge receives it", async () => {
    const pending = new PendingTeamChatInbound(2);
    const first = pending.enqueue(message({ handle: "Ev-1" }));
    const second = pending.enqueue(message({ handle: "Ev-2" }));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(pending.enqueue(message({ handle: "Ev-3" }))).toBeNull();
    expect(pending.size).toBe(2);

    const handled: string[] = [];
    pending.flush(async (event) => {
      handled.push(event.handle);
    });
    await Promise.all([first!, second!]);

    expect(handled).toEqual(["Ev-1", "Ev-2"]);
    expect(pending.size).toBe(0);
  });

  it("rejects buffered TeamChat inbound when startup stops", async () => {
    const pending = new PendingTeamChatInbound();
    const delivery = pending.enqueue(message());
    expect(delivery).not.toBeNull();
    const rejected = expect(delivery!).rejects.toThrow("startup stopped");

    pending.reject(new Error("startup stopped"));

    await rejected;
    expect(pending.size).toBe(0);
  });

  it("propagates buffered TeamChat processing failures to the webhook", async () => {
    const pending = new PendingTeamChatInbound();
    const delivery = pending.enqueue(message());
    expect(delivery).not.toBeNull();
    const rejected = expect(delivery!).rejects.toThrow("receive failed");

    pending.flush(async () => {
      throw new Error("receive failed");
    });

    await rejected;
    expect(pending.size).toBe(0);
  });

  it("bounds settlement when startup work stays blocked", async () => {
    vi.useFakeTimers();
    try {
      let resolveTask: (() => void) | undefined;
      const task = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
      const settled = settleWithTimeout(task, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(settled).resolves.toBe("timeout");
      resolveTask?.();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TeamChatBridge start cancellation", () => {
  it("lets stop() cancel an in-flight start without waiting for blocked DB work", async () => {
    let releaseFind: ((value: null) => void) | undefined;
    let enteredFind: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredFind = resolve;
    });
    const blockedFindFirst = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          enteredFind?.();
          releaseFind = resolve;
        }),
    );
    const bridge = new TeamChatBridge({
      prisma: {
        bot: { findFirst: blockedFindFirst },
        externalMessage: { findMany: vi.fn(), updateMany: vi.fn() },
        run: { findMany: vi.fn(async () => []) },
      } as unknown as PrismaClient,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
    });

    const starting = bridge.start();
    await entered;
    const stopStarted = Date.now();
    await expect(bridge.stop()).resolves.toBeUndefined();
    expect(Date.now() - stopStarted).toBeLessThan(500);

    releaseFind?.(null);
    await expect(starting).rejects.toThrow("Team chat bridge start cancelled");
  });

  it("bounds stop() when startup reconcileOnce stays blocked", async () => {
    vi.useFakeTimers();
    try {
      let releaseReconcile: (() => void) | undefined;
      const blockedReconcile = new Promise<void>((resolve) => {
        releaseReconcile = resolve;
      });
      let deferredLookups = 0;
      const findMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        // Mirror finishes immediately; block only once reconcileOnce reads deferred rows.
        if (where.threadMessageId === null) return [];
        if (where.status === "deferred") {
          deferredLookups += 1;
          await blockedReconcile;
          return [];
        }
        return [];
      });
      const bridge = new TeamChatBridge({
        prisma: {
          bot: {
            findFirst: vi.fn(async () => ({
              id: "bot-1",
              spaceId: "space-1",
              userId: "user-1",
              name: "Chief",
              modelProvider: null,
              modelId: null,
            })),
          },
          externalMessage: {
            findMany,
            updateMany: vi.fn(async () => ({ count: 0 })),
          },
          run: { findMany: vi.fn(async () => []) },
        } as unknown as PrismaClient,
        events: { sendUserMessage: vi.fn() },
        jobs: { enqueue: vi.fn() },
        send: vi.fn(),
        providerId: "slack",
        botId: "bot-1",
      });

      const starting = bridge.start();
      await vi.waitFor(() => {
        expect(deferredLookups).toBeGreaterThan(0);
      });
      const stopping = bridge.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(stopping).resolves.toBeUndefined();
      releaseReconcile?.();
      await expect(starting).rejects.toThrow("Team chat bridge start cancelled");
    } finally {
      vi.useRealTimers();
    }
  });
});

it("stops a disconnected installation's reconciliation timer and retains workspace filters", async () => {
  vi.useFakeTimers();
  let active = true;
  const available = vi.fn(async () => active);
  const onUnavailable = vi.fn();
  const updateMany = vi.fn(async () => ({ count: 0 }));
  const bridge = new TeamChatBridge({
    prisma: {
      bot: {
        findFirst: vi.fn(async () => ({
          id: "bot-a",
          spaceId: "space-a",
          userId: "owner-a",
          name: "Team",
          modelProvider: null,
          modelId: null,
        })),
      },
      externalMessage: { findMany: vi.fn(async () => []), updateMany },
      run: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient,
    events: { sendUserMessage: vi.fn() },
    jobs: { enqueue: vi.fn() },
    send: vi.fn(),
    providerId: "slack",
    botId: "bot-a",
    workspaceId: "Ta",
    conversationPrefix: "slack~install-a:",
    isAvailable: available,
    onUnavailable,
  });
  try {
    await bridge.start();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          externalConversation: expect.objectContaining({
            workspaceId: "Ta",
            conversationId: { startsWith: "slack~install-a:" },
          }),
        }),
      }),
    );
    active = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    const checks = available.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(available).toHaveBeenCalledTimes(checks);
  } finally {
    await bridge.stop();
    vi.useRealTimers();
  }
});

it("retries restoration with capped backoff and cancels retries on shutdown", async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const retries = new TeamChatStartupRetries(onError);
  const start = vi.fn(async () => {
    throw new Error("temporary database failure");
  });
  try {
    retries.schedule("install-a", start);
    retries.schedule("install-a", start);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(start).toHaveBeenCalledTimes(3);
    retries.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(start).toHaveBeenCalledTimes(3);
  } finally {
    retries.stop();
    vi.useRealTimers();
  }
});

it("a successful restore cancels pending retries without waiting for another message", async () => {
  vi.useFakeTimers();
  const retries = new TeamChatStartupRetries(vi.fn());
  const start = vi.fn(async () => undefined);
  try {
    retries.schedule("install-a", start);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(start).toHaveBeenCalledTimes(1);
    retries.schedule("install-b", start);
    retries.succeeded("install-b");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    retries.stop();
    vi.useRealTimers();
  }
});
