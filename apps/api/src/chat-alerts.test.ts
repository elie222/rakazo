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

describe("desktop push", () => {
  it("marks this session's desktop app live for the Space while the stream is open", async () => {
    const controller = new AbortController();
    const markDesktopLive = vi.fn(async () => {});
    const followChatAlerts = vi.fn(async function* () {
      yield alert;
    });
    const client = createRouterClient(
      createRouter({
        events: { followChatAlerts },
        pushTokens: { markDesktopLive },
        env: { desktopPushEnabled: true },
      } as unknown as RouterDeps),
      { context: { actor, sessionId: "session-1", signal: controller.signal } },
    );
    const iterator = (await client.notifications.subscribe())[Symbol.asyncIterator]();
    await iterator.next();
    expect(markDesktopLive).toHaveBeenCalledWith("user-1", "session-1", {
      spaceId: "space-1",
      until: expect.any(Date),
    });
    await iterator.return?.(undefined);
    expect(markDesktopLive).toHaveBeenLastCalledWith("user-1", "session-1", null);
    controller.abort();
  });

  it("does not touch registrations when the server cannot push to desktops", async () => {
    const controller = new AbortController();
    const markDesktopLive = vi.fn(async () => {});
    const client = createRouterClient(
      createRouter({
        events: {
          followChatAlerts: async function* () {
            yield alert;
          },
        },
        pushTokens: { markDesktopLive },
        env: {},
      } as unknown as RouterDeps),
      { context: { actor, sessionId: "session-1", signal: controller.signal } },
    );
    await (await client.notifications.subscribe())[Symbol.asyncIterator]().next();
    expect(markDesktopLive).not.toHaveBeenCalled();
    controller.abort();
  });

  it("registers a token only when the server can push to desktops", async () => {
    const saveDesktop = vi.fn(async () => {});
    const token = "c".repeat(64);
    const enabled = createRouterClient(
      createRouter({
        pushTokens: { saveDesktop },
        env: { desktopPushEnabled: true },
      } as unknown as RouterDeps),
      { context: { actor, sessionId: "session-1" } },
    );
    await expect(enabled.notifications.registerDesktopPush({ token })).resolves.toEqual({
      ok: true,
    });
    expect(saveDesktop).toHaveBeenCalledWith("user-1", token, "session-1");
    const disabled = createRouterClient(
      createRouter({ pushTokens: { saveDesktop }, env: {} } as unknown as RouterDeps),
      { context: { actor, sessionId: "session-1" } },
    );
    await expect(disabled.notifications.registerDesktopPush({ token })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
