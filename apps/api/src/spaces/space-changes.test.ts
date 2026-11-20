import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { pageChangesScope } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";
import { spaceChangesFor } from "./space-change-procedures.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

const followChatAlerts = async function* (_userId: string, _spaceId: string, signal: AbortSignal) {
  await new Promise((resolve) => signal.addEventListener("abort", resolve));
};

describe("notifications.subscribe space change signals", () => {
  it("sends each change to the actor's Space as its own frame", async () => {
    const controller = new AbortController();
    const followSpaceChanges = vi.fn(async function* () {
      yield "computerUpdates" as const;
      yield "runs" as const;
      yield "routines" as const;
    });
    const client = createRouterClient(
      createRouter({
        events: { followChatAlerts, followSpaceChanges },
      } as unknown as RouterDeps),
      { context: { actor, signal: controller.signal } },
    );
    try {
      const iterator = (await client.notifications.subscribe())[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ type: "computerUpdates" });
      expect((await iterator.next()).value).toEqual({ type: "runs" });
      expect((await iterator.next()).value).toEqual({ type: "routines" });
      expect(followSpaceChanges).toHaveBeenCalledWith(actor.spaceId, expect.any(AbortSignal));
    } finally {
      controller.abort();
    }
  });

  it("delivers page signals only on the signed-in account's topic", async () => {
    const controller = new AbortController();
    const followSpaceChanges = vi.fn(async function* (scope: string) {
      if (scope === actor.spaceId || scope === pageChangesScope(actor.userId)) {
        yield "pages" as const;
      }
    });
    const client = createRouterClient(
      createRouter({ events: { followChatAlerts, followSpaceChanges } } as unknown as RouterDeps),
      { context: { actor, signal: controller.signal } },
    );
    try {
      const iterator = (await client.notifications.subscribe())[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ type: "pages" });
      expect(followSpaceChanges).toHaveBeenCalledWith(
        pageChangesScope(actor.userId),
        expect.any(AbortSignal),
      );
    } finally {
      controller.abort();
    }
  });

  it("ends the stream half a minute after space change signals fail", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const followSpaceChanges = vi.fn(async function* () {
      yield "runs" as const;
      throw new Error("subscribe failed");
    });
    const client = createRouterClient(
      createRouter({
        events: { followChatAlerts, followSpaceChanges },
      } as unknown as RouterDeps),
      { context: { actor, signal: controller.signal } },
    );
    try {
      const iterator = (await client.notifications.subscribe())[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ type: "runs" });
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
    const publishSpaceChange = vi.fn(async () => {});
    const client = createRouterClient(
      createRouter({
        prisma: { computerUpdate: { updateMany } },
        events: { publishSpaceChange },
      } as unknown as RouterDeps),
      { context: { actor } },
    );
    await client.computer.dismissUpdate({ id: "update-1" });
    expect(publishSpaceChange).toHaveBeenCalledExactlyOnceWith(actor.spaceId, "computerUpdates");
    updateMany.mockResolvedValueOnce({ count: 0 });
    await client.computer.dismissUpdate({ id: "update-1" });
    expect(publishSpaceChange).toHaveBeenCalledOnce();
  });
});

describe("space change procedures", () => {
  it("signals routines after a routine is removed", async () => {
    const publishSpaceChange = vi.fn(async () => {});
    const client = createRouterClient(
      createRouter({
        prisma: {
          routine: {
            findFirst: vi.fn(async () => ({ id: "routine-1" })),
            delete: vi.fn(async () => ({})),
          },
        },
        jobs: { cancel: vi.fn(async () => {}) },
        events: { publishSpaceChange },
      } as unknown as RouterDeps),
      { context: { actor } },
    );
    await client.routines.remove({ routineId: "routine-1" });
    expect(publishSpaceChange).toHaveBeenCalledExactlyOnceWith(actor.spaceId, "routines");
  });

  it("maps a created artifact to the artifacts signal", () => {
    expect(spaceChangesFor(["artifacts", "create"])).toEqual(["artifacts"]);
  });
});
