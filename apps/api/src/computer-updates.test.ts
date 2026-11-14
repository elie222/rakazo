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

describe("computer.subscribeUpdates", () => {
  it("streams change signals for the actor's Space", async () => {
    const controller = new AbortController();
    const followComputerUpdateChanges = vi.fn(async function* () {
      yield;
      yield;
    });
    const client = createRouterClient(
      createRouter({ events: { followComputerUpdateChanges } } as unknown as RouterDeps),
      { context: { actor, signal: controller.signal } },
    );
    try {
      const iterator = (await client.computer.subscribeUpdates())[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ type: "changed" });
      expect((await iterator.next()).value).toEqual({ type: "changed" });
      expect(followComputerUpdateChanges).toHaveBeenCalledWith(
        actor.spaceId,
        expect.any(AbortSignal),
      );
    } finally {
      controller.abort();
    }
  });

  it("is unavailable without a realtime fanout, so the app keeps polling", async () => {
    const client = createRouterClient(createRouter({ events: {} } as unknown as RouterDeps), {
      context: { actor },
    });
    const iterator = (await client.computer.subscribeUpdates())[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires a signed-in user", async () => {
    const client = createRouterClient(createRouter({} as unknown as RouterDeps), {
      context: { actor: null },
    });
    await expect(client.computer.subscribeUpdates()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
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
