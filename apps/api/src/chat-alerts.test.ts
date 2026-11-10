import { createRouterClient } from "@orpc/server";
import type { Actor, ChatAlert } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

const alert: ChatAlert = {
  kind: "completion",
  title: "Scout finished",
  body: "The report is ready.",
  spaceId: "space-1",
  botId: "bot-1",
  threadId: "thread-1",
};

describe("notifications.subscribe", () => {
  it("streams the user's alerts for this space only", async () => {
    const controller = new AbortController();
    const followChatAlerts = vi.fn(async function* () {
      yield { ...alert, spaceId: "space-2", body: "Another space" };
      yield alert;
    });
    const client = createRouterClient(
      createRouter({ events: { followChatAlerts } } as unknown as RouterDeps),
      { context: { actor, signal: controller.signal } },
    );
    try {
      const iterator = (await client.notifications.subscribe())[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ type: "alert", alert });
      expect(followChatAlerts).toHaveBeenCalledWith(
        actor.userId,
        actor.spaceId,
        expect.any(AbortSignal),
      );
    } finally {
      controller.abort();
    }
  });

  it("requires a signed-in user", async () => {
    const client = createRouterClient(createRouter({} as unknown as RouterDeps), {
      context: { actor: null },
    });
    await expect(client.notifications.subscribe()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
