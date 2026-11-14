import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

describe("notifications.subscribe computer update signals", () => {
  it("signals changes to the actor's Space's computer updates", async () => {
    const controller = new AbortController();
    const followChatAlerts = vi.fn(async function* (
      _userId: string,
      _spaceId: string,
      signal: AbortSignal,
    ) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
    });
    const followComputerUpdateChanges = vi.fn(async function* () {
      yield;
      yield;
    });
    const client = createRouterClient(
      createRouter({
        events: { followChatAlerts, followComputerUpdateChanges },
      } as unknown as RouterDeps),
      { context: { actor, signal: controller.signal } },
    );
    try {
      const iterator = (await client.notifications.subscribe())[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ type: "computerUpdates" });
      expect((await iterator.next()).value).toEqual({ type: "computerUpdates" });
      expect(followComputerUpdateChanges).toHaveBeenCalledWith(
        actor.spaceId,
        expect.any(AbortSignal),
      );
    } finally {
      controller.abort();
    }
  });

  it("ends the stream half a minute after computer update signals fail", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const followChatAlerts = vi.fn(async function* (
      _userId: string,
      _spaceId: string,
      signal: AbortSignal,
    ) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
    });
    const followComputerUpdateChanges = vi.fn(async function* () {
      yield;
      throw new Error("subscribe failed");
    });
    const client = createRouterClient(
      createRouter({
        events: { followChatAlerts, followComputerUpdateChanges },
      } as unknown as RouterDeps),
      { context: { actor, signal: controller.signal } },
    );
    try {
      const iterator = (await client.notifications.subscribe())[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ type: "computerUpdates" });
      const started = Date.now();
      let endedAt: number | undefined;
      // Heartbeats and alerts keep flowing until the stream ends.
      const drained = (async () => {
        try {
          while (!(await iterator.next()).done);
        } catch (error) {
          endedAt = Date.now();
          throw error;
        }
      })();
      drained.catch(() => {});
      await vi.advanceTimersByTimeAsync(29_000);
      expect(endedAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(drained).rejects.toThrow("subscribe failed");
      expect(endedAt! - started).toBe(30_000);
    } finally {
      controller.abort();
      vi.useRealTimers();
    }
  });
});

describe("computer.dismissUpdate", () => {
  it("signals the Space only when a failed update was dismissed", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const publishComputerUpdateChange = vi.fn(async () => {});
    const client = createRouterClient(
      createRouter({
        prisma: { computerUpdate: { updateMany } },
        events: { publishComputerUpdateChange },
      } as unknown as RouterDeps),
      { context: { actor } },
    );
    await client.computer.dismissUpdate({ id: "update-1" });
    expect(publishComputerUpdateChange).toHaveBeenCalledExactlyOnceWith(actor.spaceId);
    updateMany.mockResolvedValueOnce({ count: 0 });
    await client.computer.dismissUpdate({ id: "update-1" });
    expect(publishComputerUpdateChange).toHaveBeenCalledOnce();
  });
});
