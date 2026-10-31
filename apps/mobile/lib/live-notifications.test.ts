import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-modules-core", () => ({ requireNativeModule: vi.fn() }));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  getPresentedNotificationsAsync: vi.fn(async () => []),
  dismissNotificationAsync: vi.fn(async () => undefined),
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-secure-store", () => ({}));

import * as Notifications from "expo-notifications";
import {
  afterChatNotifyChange,
  configureForegroundNotifications,
  dismissThreadNotifications,
  notificationTargetsThread,
  setOpenNotificationThread,
} from "./live-notifications";

beforeEach(() => vi.clearAllMocks());

// The handler is installed once per module; keep it across cleared mocks.
let foreground: Parameters<typeof Notifications.setNotificationHandler>[0] | undefined;
function foregroundHandler() {
  configureForegroundNotifications();
  foreground ??= vi.mocked(Notifications.setNotificationHandler).mock.calls[0]?.[0];
  return foreground;
}

describe("notification thread targeting", () => {
  it("matches Expo and native notification keys for the open agent", () => {
    expect(notificationTargetsThread({ botId: "bot-1" }, { botId: "bot-1" })).toBe(true);
    expect(
      notificationTargetsThread(
        { "rakazo.threadId": "thread-1" },
        { botId: "bot-1", threadId: "thread-1" },
      ),
    ).toBe(true);
  });

  it("keeps other agents visible", () => {
    expect(notificationTargetsThread({ botId: "bot-2" }, { botId: "bot-1" })).toBe(false);
    expect(notificationTargetsThread({ botId: "bot-1" }, null)).toBe(false);
  });

  it("does not confuse an open DM with a group notification from the same agent", () => {
    expect(
      notificationTargetsThread(
        { botId: "bot-1", threadId: "group-thread" },
        { botId: "bot-1", threadId: "dm-thread" },
      ),
    ).toBe(false);
  });

  it("tells a bot's own chat apart from a group it posted in", () => {
    const groupPush = { botId: "bot-1", threadId: "group-thread", groupId: "group-1" };
    expect(notificationTargetsThread(groupPush, { botId: "bot-1" })).toBe(false);
    expect(notificationTargetsThread(groupPush, { groupId: "group-1" })).toBe(true);
    expect(notificationTargetsThread({ "rakazo.groupId": "group-1" }, { groupId: "group-1" })).toBe(
      true,
    );
    expect(notificationTargetsThread({ botId: "bot-1" }, { groupId: "group-1" })).toBe(false);
  });

  it("keeps finished-work pushes silent while the app is open, for every chat", async () => {
    await setOpenNotificationThread({ botId: "bot-1" });
    const handler = foregroundHandler();
    const silent = {
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
    await expect(
      handler?.handleNotification({
        request: { content: { data: { kind: "completion", botId: "bot-2" } } },
      } as never),
    ).resolves.toEqual(silent);
    await expect(
      handler?.handleNotification({
        request: { content: { data: { kind: "help", botId: "bot-2" } } },
      } as never),
    ).resolves.toMatchObject({ shouldShowBanner: true, shouldShowList: true });
  });

  it.each(["help", "takeover", "failure"])("still presents %s from another chat", async (kind) => {
    await setOpenNotificationThread({ botId: "bot-1" });
    await expect(
      foregroundHandler()?.handleNotification({
        request: { content: { data: { kind, botId: "bot-2" } } },
      } as never),
    ).resolves.toMatchObject({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldSetBadge: false,
    });
  });

  it("dismisses a group's notifications without dismissing its bots' direct chats", async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      {
        request: { identifier: "group", content: { data: { groupId: "group-1", botId: "bot-1" } } },
      },
      {
        request: { identifier: "native-group", content: { data: { "rakazo.groupId": "group-1" } } },
      },
      { request: { identifier: "bot", content: { data: { botId: "bot-1" } } } },
      { request: { identifier: "other-group", content: { data: { groupId: "group-2" } } } },
    ] as never);
    await dismissThreadNotifications({ groupId: "group-1" });
    expect(vi.mocked(Notifications.dismissNotificationAsync).mock.calls).toEqual([
      ["group"],
      ["native-group"],
    ]);
  });

  it("hides only foreground notifications for the open agent", async () => {
    await setOpenNotificationThread({ botId: "bot-1" });
    const handler = foregroundHandler();
    expect(handler).toBeTruthy();

    await expect(
      handler?.handleNotification({ request: { content: { data: { botId: "bot-1" } } } } as never),
    ).resolves.toMatchObject({ shouldShowBanner: false, shouldShowList: false });
    await expect(
      handler?.handleNotification({ request: { content: { data: { botId: "bot-2" } } } } as never),
    ).resolves.toMatchObject({ shouldShowBanner: true, shouldShowList: true });
  });
});

describe("after a chat's notifications change", () => {
  it("clears that chat's delivered notifications only when they are turned off", async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      { request: { identifier: "a", content: { data: { threadId: "thread-1" } } } },
      { request: { identifier: "b", content: { data: { threadId: "thread-2" } } } },
    ] as never);

    await afterChatNotifyChange("", "", "", { threadId: "thread-1", notify: true });
    expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled();

    await afterChatNotifyChange("", "", "", { threadId: "thread-1", notify: false });
    expect(vi.mocked(Notifications.dismissNotificationAsync).mock.calls).toEqual([["a"]]);
  });
});
