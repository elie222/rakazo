import { beforeEach, describe, expect, it, vi } from "vitest";

const secureStorage = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-modules-core", () => ({ requireNativeModule: vi.fn() }));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  getPresentedNotificationsAsync: vi.fn(async () => []),
  dismissNotificationAsync: vi.fn(async () => undefined),
  dismissAllNotificationsAsync: vi.fn(async () => undefined),
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => secureStorage.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStorage.set(key, value);
  }),
}));

import * as Notifications from "expo-notifications";
import {
  afterChatNotifyChange,
  configureForegroundNotifications,
  dismissThreadNotifications,
  notificationTargetsThread,
  setOpenNotificationThread,
  stopLiveNotifications,
} from "./live-notifications";
import { loadSavedAccounts, rememberSavedAccount, setSelectedSavedAccount } from "./saved-accounts";

beforeEach(async () => {
  vi.clearAllMocks();
  secureStorage.clear();
  setSelectedSavedAccount(null);
  await loadSavedAccounts("https://app.example.test");
});

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
  it("keeps deliveries when no account owns the cleanup", async () => {
    await stopLiveNotifications();
    expect(Notifications.dismissAllNotificationsAsync).not.toHaveBeenCalled();

    await stopLiveNotifications(true);
    expect(Notifications.dismissAllNotificationsAsync).not.toHaveBeenCalled();
  });
});

it("keeps inactive-account completions visible and never dismisses their matching thread ID", async () => {
  setSelectedSavedAccount({ apiBase: "https://app.example.test", userId: "family" });
  await setOpenNotificationThread({ botId: "bot-1", threadId: "thread-1" });
  await expect(
    foregroundHandler()?.handleNotification({
      request: { content: { data: { userId: "work", kind: "completion", threadId: "thread-1" } } },
    } as never),
  ).resolves.toMatchObject({ shouldShowBanner: true });
  expect(
    notificationTargetsThread({ userId: "work", threadId: "thread-1" }, { threadId: "thread-1" }),
  ).toBe(false);
  setSelectedSavedAccount(null);
});

it.each(["completion", "help"])(
  "keeps untagged %s visible when several accounts are saved",
  async (kind) => {
    const apiBase = "https://app.example.test";
    for (const userId of ["family", "work"]) {
      await rememberSavedAccount(apiBase, {
        userId,
        token: `${userId}-token`,
        email: `${userId}@example.test`,
        name: userId,
        image: null,
        unread: 0,
      });
    }
    setSelectedSavedAccount({ apiBase, userId: "family" });
    await setOpenNotificationThread({ threadId: "thread-1" });
    await expect(
      foregroundHandler()?.handleNotification({
        request: { content: { data: { kind, threadId: "thread-1" } } },
      } as never),
    ).resolves.toMatchObject({ shouldShowBanner: true, shouldShowList: true });
    expect(notificationTargetsThread({ threadId: "thread-1" }, { threadId: "thread-1" })).toBe(
      false,
    );
    await expect(
      foregroundHandler()?.handleNotification({
        request: { content: { data: { kind, threadId: "thread-1", userId: "family", apiBase } } },
      } as never),
    ).resolves.toMatchObject({ shouldShowBanner: false, shouldShowList: false });
  },
);

it("keeps an untagged completion visible before saved account selection initializes", async () => {
  const apiBase = "https://app.example.test";
  secureStorage.set(
    "rakazo.saved_accounts",
    JSON.stringify({
      [apiBase]: ["family", "work"].map((userId) => ({
        userId,
        token: `${userId}-token`,
        email: `${userId}@example.test`,
        name: userId,
        image: null,
        unread: 0,
      })),
    }),
  );
  await expect(
    foregroundHandler()?.handleNotification({
      request: { content: { data: { kind: "completion", threadId: "thread-1" } } },
    } as never),
  ).resolves.toMatchObject({ shouldShowBanner: true, shouldShowList: true });
});

it("keeps a notification visible when its server is ambiguous", async () => {
  for (const apiBase of ["https://app.example.test", "https://other.example.test"]) {
    await rememberSavedAccount(apiBase, {
      userId: "family",
      token: "token",
      email: "family@example.test",
      name: "Family",
      image: null,
      unread: 0,
    });
  }
  setSelectedSavedAccount({ apiBase: "https://app.example.test", userId: "family" });
  await setOpenNotificationThread({ threadId: "thread-1" });
  await expect(
    foregroundHandler()?.handleNotification({
      request: {
        content: { data: { kind: "completion", threadId: "thread-1", userId: "family" } },
      },
    } as never),
  ).resolves.toMatchObject({ shouldShowBanner: true });
});

it("signing out dismisses only the selected account's delivered notifications", async () => {
  setSelectedSavedAccount({ apiBase: "https://app.example.test", userId: "family" });
  vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValueOnce([
    { request: { identifier: "family-notice", content: { data: { userId: "family" } } } },
    { request: { identifier: "work-notice", content: { data: { userId: "work" } } } },
  ] as never);
  await stopLiveNotifications(true);
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith("family-notice");
  expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalledWith("work-notice");
  setSelectedSavedAccount(null);
});

it("keeps another server's notification when cloned account and thread IDs match", async () => {
  setSelectedSavedAccount({ apiBase: "https://app.example.test", userId: "family" });
  await setOpenNotificationThread({ threadId: "thread-1" });
  expect(
    notificationTargetsThread(
      { userId: "family", apiBase: "https://other.example.test", threadId: "thread-1" },
      { threadId: "thread-1" },
    ),
  ).toBe(false);
  vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValueOnce([
    {
      request: {
        identifier: "other-server",
        content: { data: { userId: "family", apiBase: "https://other.example.test" } },
      },
    },
  ] as never);
  await stopLiveNotifications(true);
  expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalledWith("other-server");
  setSelectedSavedAccount(null);
});
