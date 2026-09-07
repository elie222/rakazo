import type { MessagingInboundMessage } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { TeamChatBridge } from "./team-chat-bridge.js";
import {
  PendingTeamChatInbound,
  prefersTeamChatSurface,
  settleWithTimeout,
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
    expect(prefersTeamChatSurface(message(), "bot-1")).toBe(true);
    expect(
      prefersTeamChatSurface(message({ provider: "sendblue", workspaceId: undefined }), "bot-1"),
    ).toBe(false);
    expect(prefersTeamChatSurface(message(), undefined)).toBe(false);
  });

  it("buffers TeamChat inbound until the bridge can receive", () => {
    const pending = new PendingTeamChatInbound(2);
    expect(pending.enqueue(message({ handle: "Ev-1" }))).toBe(true);
    expect(pending.enqueue(message({ handle: "Ev-2" }))).toBe(true);
    expect(pending.enqueue(message({ handle: "Ev-3" }))).toBe(false);
    expect(pending.size).toBe(2);
    expect(pending.drain().map((event) => event.handle)).toEqual(["Ev-1", "Ev-2"]);
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
});
