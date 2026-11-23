import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import type { NavigationState } from "expo-router/react-navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-notifications", () => ({
  DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
  addNotificationResponseReceivedListener: vi.fn(),
  clearLastNotificationResponse: vi.fn(),
  getLastNotificationResponse: vi.fn(),
  useLastNotificationResponse: vi.fn(),
}));
vi.mock("expo-router", () => ({
  router: { dismissTo: vi.fn(), push: vi.fn() },
}));
vi.mock("expo-router/react-navigation", () => ({
  CommonActions: { reset: (payload: unknown) => ({ type: "RESET", payload }) },
}));
vi.mock("../api/session", () => ({
  loadSessionToken: vi.fn(),
}));

import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { loadSessionToken } from "../api/session";
import { threadRouteId } from "./notification-open";
import { openNotificationResponse as openResponse } from "./open-notification";

const DEFAULT_ACTION = "expo.modules.notifications.actions.DEFAULT";
const navigation = { getRootState: vi.fn<() => NavigationState>(), dispatch: vi.fn() };

function openNotificationResponse(response: Notifications.NotificationResponse | null) {
  return openResponse(response, navigation);
}

function rootWithChatStack(routes: NavigationState["routes"]): NavigationState {
  const stack: NavigationState = {
    stale: false,
    type: "stack",
    key: "app-stack",
    index: routes.length - 1,
    routeKeySeq: routes.length,
    routeNames: [
      "index",
      "thread",
      "group-thread",
      "(settings)",
      "share",
      "new-bot",
      "new-group",
      "new-space",
    ],
    routes,
  };
  return {
    stale: false,
    type: "stack",
    key: "expo-root",
    index: 0,
    routeKeySeq: 1,
    routeNames: ["__root"],
    routes: [{ name: "__root", key: "root-slot", state: stack }],
  };
}

function settingsSheet(
  pages: (string | NavigationState["routes"][number])[],
  key = "settings",
): NavigationState["routes"][number] {
  const routes = pages.map((page) => (typeof page === "string" ? { name: page, key: page } : page));
  return {
    name: "(settings)",
    key,
    state: {
      stale: false,
      type: "stack",
      key: "settings-stack",
      index: routes.length - 1,
      routeKeySeq: routes.length,
      routeNames: routes.map(({ name }) => name),
      routes,
    },
  };
}

function tap(id: string, data: Record<string, unknown> = { botId: "bot-1", threadId: "thread-1" }) {
  return {
    actionIdentifier: DEFAULT_ACTION,
    notification: { request: { identifier: id, content: { data } } },
  } as Notifications.NotificationResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
  navigation.getRootState.mockReset();
});

describe("opening a notification tap", () => {
  it("opens a different chat with the list as its back route", async () => {
    vi.mocked(loadSessionToken).mockResolvedValue("token");
    const inbox = { name: "index", key: "inbox" };
    navigation.getRootState.mockReturnValue(
      rootWithChatStack([inbox, { name: "thread", key: "prior-chat", params: { botId: "bot-2" } }]),
    );

    await expect(openNotificationResponse(tap("tap-over-other-chat"))).resolves.toBe(true);
    expect(navigation.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        target: "app-stack",
        payload: expect.objectContaining({
          index: 1,
          routes: [inbox, { name: "thread", params: { botId: "bot-1", threadId: "thread-1" } }],
        }),
      }),
    );
  });

  it("returns to the chat list after opening a notification from settings", async () => {
    vi.mocked(loadSessionToken).mockResolvedValue("token");
    const inbox = { name: "index", key: "inbox" };
    navigation.getRootState.mockReturnValue(
      rootWithChatStack([
        inbox,
        { name: "thread", key: "prior-chat", params: { botId: "bot-2" } },
        settingsSheet(["account", "memory-note"]),
      ]),
    );

    await expect(openNotificationResponse(tap("tap-over-settings"))).resolves.toBe(true);

    expect(navigation.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "RESET",
        target: "app-stack",
        payload: expect.objectContaining({
          index: 1,
          routes: [inbox, { name: "thread", params: { botId: "bot-1", threadId: "thread-1" } }],
        }),
      }),
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each([...["new-bot", "new-group", "new-space"].map((name) => ({ name, key: name }))])(
    "opens above $key without removing it",
    async (screen) => {
      vi.mocked(loadSessionToken).mockResolvedValue("token");
      navigation.getRootState.mockReturnValue(
        rootWithChatStack([
          { name: "index", key: "inbox" },
          { name: "thread", key: "prior-chat", params: { botId: "bot-2" } },
          screen,
        ]),
      );

      await expect(openNotificationResponse(tap(`tap-over-${screen.key}`))).resolves.toBe(true);

      expect(navigation.dispatch).not.toHaveBeenCalled();
      expect(router.dismissTo).not.toHaveBeenCalled();
      expect(router.push).toHaveBeenCalledExactlyOnceWith(
        { pathname: "/thread", params: { botId: "bot-1", threadId: "thread-1" } },
        { dangerouslySingular: threadRouteId },
      );
    },
  );

  it("opens a notification above the protected share picker with ordinary chat parameters", async () => {
    vi.mocked(loadSessionToken).mockResolvedValue("token");
    navigation.getRootState.mockReturnValue(
      rootWithChatStack([
        { name: "index", key: "inbox" },
        { name: "share", key: "share" },
      ]),
    );

    await expect(openNotificationResponse(tap("tap-over-share"))).resolves.toBe(true);

    expect(navigation.dispatch).not.toHaveBeenCalled();
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledExactlyOnceWith(
      {
        pathname: "/thread",
        params: { botId: "bot-1", threadId: "thread-1" },
      },
      { dangerouslySingular: threadRouteId },
    );
  });

  it("keeps the open chat screen for a new delivery and makes Back return to the list", async () => {
    vi.mocked(loadSessionToken).mockResolvedValue("token");
    const inbox = { name: "index", key: "inbox" };
    navigation.getRootState.mockReturnValue(
      rootWithChatStack([
        inbox,
        { name: "group-thread", key: "other-chat", params: { groupId: "bot-1" } },
        { name: "thread", key: "active-chat", params: { botId: "bot-1", readOnly: "1" } },
      ]),
    );
    const params = { botId: "bot-1", threadId: "thread-1", spaceId: "space-1" };

    await expect(openNotificationResponse(tap("active-chat", params))).resolves.toBe(true);

    expect(navigation.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "RESET",
        target: "app-stack",
        payload: expect.objectContaining({
          index: 1,
          routes: [inbox, { name: "thread", key: "active-chat", params }],
        }),
      }),
    );
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("keeps a group opened by a deep link and adds a chat-list back route", async () => {
    vi.mocked(loadSessionToken).mockResolvedValue("token");
    const params = { groupId: "group-1", threadId: "thread-2" };
    const group = { name: "group-thread", key: "active-group", params };
    navigation.getRootState.mockReturnValue(rootWithChatStack([group]));

    await expect(openNotificationResponse(tap("active-group", params))).resolves.toBe(true);

    expect(navigation.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        target: "app-stack",
        payload: expect.objectContaining({ index: 1, routes: [{ name: "index" }, group] }),
      }),
    );
  });

  it("opens a signed-in tap once when the cold start and the listener both see it", async () => {
    let release!: Deferred<string>;
    vi.mocked(loadSessionToken).mockImplementation(() => {
      release = deferred<string>();
      return release.promise;
    });
    const response = tap("tap-signed-in");
    const first = openNotificationResponse(response);
    const second = openNotificationResponse(response);
    release.resolve("token");
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      { pathname: "/thread", params: { botId: "bot-1", threadId: "thread-1" } },
      { dangerouslySingular: threadRouteId, withAnchor: true },
    );
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
  });

  it("drops a signed-out tap so a later cold start cannot replay it", async () => {
    vi.mocked(loadSessionToken).mockResolvedValue("");
    const response = tap("tap-signed-out", {
      botId: "bot-1",
      threadId: "thread-1",
      spaceId: "space-2",
    });
    vi.mocked(Notifications.getLastNotificationResponse).mockReturnValue(response);
    await expect(openNotificationResponse(response)).resolves.toBe(false);
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);

    vi.mocked(loadSessionToken).mockResolvedValue("token");
    await expect(openNotificationResponse(response)).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("leaves the last response in place when the tap cannot be opened or the session read fails", async () => {
    vi.mocked(loadSessionToken).mockResolvedValue("");
    await expect(openNotificationResponse(null)).resolves.toBe(false);
    await expect(openNotificationResponse(tap("tap-empty", { kind: "completion" }))).resolves.toBe(
      false,
    );
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();

    vi.mocked(loadSessionToken).mockRejectedValue(new Error("locked"));
    await expect(openNotificationResponse(tap("tap-locked"))).resolves.toBe(false);
    expect(router.push).not.toHaveBeenCalled();
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();

    vi.mocked(loadSessionToken).mockResolvedValue("token");
    await expect(openNotificationResponse(tap("tap-locked"))).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("leaves a newer last response in place when an older signed-out tap is rejected", async () => {
    let release!: Deferred<string>;
    vi.mocked(loadSessionToken).mockImplementation(() => {
      release = deferred<string>();
      return release.promise;
    });
    const older = tap("tap-older");
    const newer = tap("tap-newer", { botId: "bot-2", threadId: "thread-2" });
    vi.mocked(Notifications.getLastNotificationResponse).mockReturnValue(older);
    const pending = openNotificationResponse(older);
    vi.mocked(Notifications.getLastNotificationResponse).mockReturnValue(newer);
    release.resolve("");
    await expect(pending).resolves.toBe(false);
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    vi.mocked(loadSessionToken).mockResolvedValue("token");
    await expect(openNotificationResponse(newer)).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      { pathname: "/thread", params: { botId: "bot-2", threadId: "thread-2" } },
      { dangerouslySingular: threadRouteId, withAnchor: true },
    );
  });

  it("treats two deliveries that share a request identifier as different taps", async () => {
    const releases: Array<(token: string) => void> = [];
    vi.mocked(loadSessionToken).mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const shared = { botId: "bot-1", threadId: "thread-1" };
    const older = tap("thread-shared-out", { ...shared, deliveryId: "delivery-out-1" });
    const newer = tap("thread-shared-out", { ...shared, deliveryId: "delivery-out-2" });
    vi.mocked(Notifications.getLastNotificationResponse).mockReturnValue(older);
    const pendingOlder = openNotificationResponse(older);
    vi.mocked(Notifications.getLastNotificationResponse).mockReturnValue(newer);
    const pendingNewer = openNotificationResponse(newer);

    releases[0]?.("");
    await expect(pendingOlder).resolves.toBe(false);
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    releases[1]?.("token");
    await expect(pendingNewer).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("opens both signed-in deliveries that share a request identifier", async () => {
    const releases: Array<(token: string) => void> = [];
    vi.mocked(loadSessionToken).mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const shared = { botId: "bot-1", threadId: "thread-1" };
    const first = tap("thread-shared-in", { ...shared, deliveryId: "delivery-in-1" });
    const second = tap("thread-shared-in", { ...shared, deliveryId: "delivery-in-2" });
    vi.mocked(Notifications.getLastNotificationResponse).mockReturnValue(second);
    const pendingFirst = openNotificationResponse(first);
    const pendingSecond = openNotificationResponse(second);
    releases[0]?.("token");
    releases[1]?.("token");
    await expect(pendingFirst).resolves.toBe(true);
    await expect(pendingSecond).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(2);
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("opens one shared-identifier delivery only once", async () => {
    vi.mocked(loadSessionToken).mockResolvedValue("token");
    const data = { botId: "bot-1", threadId: "thread-1", deliveryId: "delivery-once" };
    await expect(openNotificationResponse(tap("thread-shared-once", data))).resolves.toBe(true);
    await expect(openNotificationResponse(tap("thread-shared-once", data))).resolves.toBe(false);
    expect(router.push).toHaveBeenCalledTimes(1);
  });
});
