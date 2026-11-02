import { beforeEach, describe, expect, it, vi } from "vitest";

const secureStorage = vi.hoisted(() => new Map<string, string>());
const session = vi.hoisted(() => ({ token: "" }));
vi.mock("expo-modules-core", () => ({ requireNativeModule: vi.fn() }));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  getPresentedNotificationsAsync: vi.fn(async () => []),
  dismissNotificationAsync: vi.fn(async () => undefined),
  dismissAllNotificationsAsync: vi.fn(async () => undefined),
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(async (key: string) => {
    secureStorage.delete(key);
  }),
  getItemAsync: vi.fn(async (key: string) => secureStorage.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStorage.set(key, value);
  }),
}));
vi.mock("./session", () => ({ loadSessionToken: async () => session.token }));

import * as Notifications from "expo-notifications";
import {
  afterChatNotifyChange,
  configureForegroundNotifications,
  dismissThreadNotifications,
  notificationTargetsThread,
  setOpenNotificationThread,
  stopLiveNotifications,
} from "./live-notifications";
import { rememberSavedAccount, rememberServerOrigin } from "./saved-accounts";

const apiBase = "https://app.example.test";
beforeEach(() => {
  vi.clearAllMocks();
  secureStorage.clear();
  session.token = "";
});

async function signInAs(active: string, ...others: string[]) {
  for (const userId of [active, ...others])
    await rememberSavedAccount(apiBase, {
      userId,
      token: `${userId}-token`,
      email: `${userId}@example.test`,
    });
  session.token = `${active}-token`;
}

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

describe("when the session ends", () => {
  it("clears every delivered notification once no login remains", async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      { request: { identifier: "family", content: { data: { userId: "family" } } } },
      { request: { identifier: "legacy", content: { data: {} } } },
    ] as never);
    await stopLiveNotifications();
    expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled();

    await stopLiveNotifications(true);
    expect(vi.mocked(Notifications.dismissNotificationAsync).mock.calls).toEqual([
      ["family"],
      ["legacy"],
    ]);
  });

  it("keeps the delivered notifications of logins still on this device", async () => {
    await signInAs("work");
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      { request: { identifier: "family", content: { data: { userId: "family" } } } },
      { request: { identifier: "work", content: { data: { "rakazo.userId": "work" } } } },
      { request: { identifier: "legacy", content: { data: {} } } },
    ] as never);
    await stopLiveNotifications(true);
    expect(vi.mocked(Notifications.dismissNotificationAsync).mock.calls).toEqual([["family"]]);
  });
});

describe("with several logins", () => {
  it("alerts for another login's work, even for the open thread's ID", async () => {
    await signInAs("family", "work");
    await setOpenNotificationThread({ botId: "bot-1", threadId: "thread-1" });
    await expect(
      foregroundHandler()?.handleNotification({
        request: {
          content: { data: { userId: "work", kind: "completion", threadId: "thread-1" } },
        },
      } as never),
    ).resolves.toMatchObject({ shouldShowBanner: true });
    await expect(
      foregroundHandler()?.handleNotification({
        request: {
          content: {
            data: { userId: "family", apiBase, kind: "completion", threadId: "thread-1" },
          },
        },
      } as never),
    ).resolves.toMatchObject({ shouldShowBanner: false });
  });

  it("alerts for an untagged delivery whose login is ambiguous", async () => {
    await signInAs("family", "work");
    await setOpenNotificationThread({ threadId: "thread-1" });
    await expect(
      foregroundHandler()?.handleNotification({
        request: { content: { data: { kind: "completion", threadId: "thread-1" } } },
      } as never),
    ).resolves.toMatchObject({ shouldShowBanner: true, shouldShowList: true });
  });

  it("recognizes the server by the same names a notification tap accepts", async () => {
    await signInAs("family", "work");
    await rememberServerOrigin(apiBase, "https://web.example.test");
    await setOpenNotificationThread({ threadId: "thread-1" });
    for (const name of [`${apiBase}/`, "https://web.example.test"])
      await expect(
        foregroundHandler()?.handleNotification({
          request: {
            content: {
              data: { userId: "family", apiBase: name, kind: "completion", threadId: "thread-1" },
            },
          },
        } as never),
      ).resolves.toMatchObject({ shouldShowBanner: false });
    await expect(
      foregroundHandler()?.handleNotification({
        request: {
          content: {
            data: {
              userId: "family",
              apiBase: "https://other.example.test",
              kind: "completion",
              threadId: "thread-1",
            },
          },
        },
      } as never),
    ).resolves.toMatchObject({ shouldShowBanner: true });
  });

  it("dismisses a read thread's notifications only for the active login", async () => {
    await signInAs("family", "work");
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValueOnce([
      { request: { identifier: "family", content: { data: { userId: "family", threadId: "t" } } } },
      { request: { identifier: "work", content: { data: { userId: "work", threadId: "t" } } } },
    ] as never);
    await dismissThreadNotifications({ threadId: "t" });
    expect(vi.mocked(Notifications.dismissNotificationAsync).mock.calls).toEqual([["family"]]);
  });
});
