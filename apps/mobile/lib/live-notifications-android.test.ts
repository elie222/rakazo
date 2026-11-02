import { beforeEach, describe, expect, it, vi } from "vitest";

const { native } = vi.hoisted(() => ({
  native: {
    setAccount: undefined as undefined | ((userId: string, label: string) => Promise<void>),
    getSettings: vi.fn(async () => ({
      liveConnection: false,
      messages: true,
      scheduledTasks: true,
      needsAttention: true,
    })),
    setSettings: vi.fn(async (..._args: unknown[]) => undefined),
    setOpenThread: vi.fn(async (): Promise<void> => undefined),
    resume: vi.fn(async (): Promise<void> => undefined),
    stop: vi.fn(async (): Promise<void> => undefined),
  },
}));

vi.mock("expo-modules-core", () => ({ requireNativeModule: () => native }));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  dismissAllNotificationsAsync: vi.fn(),
  getPresentedNotificationsAsync: vi.fn(async () => []),
  getPermissionsAsync: vi.fn(async () => ({ granted: true })),
  requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("./session", () => ({ loadSessionToken: async () => "" }));
vi.mock("./i18n", () => ({ getActiveUiLocale: () => "de", t: (text: string) => text }));
const store = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: async (key: string, value: string) => void store.set(key, value),
  deleteItemAsync: async (key: string) => void store.delete(key),
}));

import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import {
  DEFAULT_LIVE_NOTIFICATION_SETTINGS,
  resumeLiveNotifications,
  setLiveNotificationSettings,
  stopLiveNotifications,
} from "./live-notifications";
import { loadSavedAccounts, rememberSavedAccount } from "./saved-accounts";
import { saveServerHeaders } from "./server-headers";

beforeEach(() => {
  store.clear();
  native.setAccount = undefined;
  native.stop.mockClear();
  native.setSettings.mockClear();
  native.resume.mockClear();
  native.getSettings.mockReset().mockResolvedValue({
    liveConnection: false,
    messages: true,
    scheduledTasks: true,
    needsAttention: true,
  });
});

const endpoint = "https://app.example.test";
const account = (userId: string) => ({
  userId,
  token: `${userId}-token`,
  email: `${userId}@example.test`,
});

describe("Android live notification resume", () => {
  beforeEach(() => {
    native.resume.mockReset();
  });

  it("resumes the native poller with the normalized server and the active UI locale", async () => {
    await resumeLiveNotifications(" app.example.test/api/ ", "token-1", "space-1");
    expect(native.resume).toHaveBeenCalledWith(
      "https://app.example.test",
      "token-1",
      "space-1",
      "de",
      "",
    );
  });

  it("hands the server's custom headers to the native poller", async () => {
    await saveServerHeaders("https://app.example.test", { "CF-Access-Client-Id": "id" });
    await resumeLiveNotifications("https://app.example.test", "token-1", "space-1");
    await saveServerHeaders("https://app.example.test", {});
    expect(native.resume).toHaveBeenCalledWith(
      "https://app.example.test",
      "token-1",
      "space-1",
      "de",
      JSON.stringify({ "CF-Access-Client-Id": "id" }),
    );
  });

  it("does not resume for a public http server, an invalid URL, or no token", async () => {
    await resumeLiveNotifications("http://app.example.test", "token-1", "space-1");
    await resumeLiveNotifications("not a url", "token-1", "space-1");
    await resumeLiveNotifications("https://app.example.test", "", "space-1");
    expect(native.resume).not.toHaveBeenCalled();
  });
});

describe("Android account ownership", () => {
  beforeEach(() => {
    native.setAccount = vi.fn(async () => undefined);
  });

  it("labels the poller's alerts with the account only when several are saved", async () => {
    await rememberSavedAccount(endpoint, account("family"));
    await resumeLiveNotifications(endpoint, "family-token", "space-1");
    expect(native.setAccount).toHaveBeenLastCalledWith("family", "");
    expect(native.resume).toHaveBeenCalledWith(endpoint, "family-token", "space-1", "de", "");

    await rememberSavedAccount(endpoint, account("work"));
    await resumeLiveNotifications(endpoint, "family-token", "space-1");
    expect(native.setAccount).toHaveBeenLastCalledWith("family", "family@example.test");
  });

  it("restores each account's own preferences in a shared Space", async () => {
    const family = { ...DEFAULT_LIVE_NOTIFICATION_SETTINGS, liveConnection: true, messages: false };
    await rememberSavedAccount(endpoint, account("family"));
    await rememberSavedAccount(endpoint, {
      ...account("work"),
      notifications: DEFAULT_LIVE_NOTIFICATION_SETTINGS,
    });
    await setLiveNotificationSettings(family, endpoint, "family-token", "shared-space");
    expect((await loadSavedAccounts(endpoint))[0]?.notifications).toEqual(family);

    await resumeLiveNotifications(endpoint, "work-token", "shared-space");
    expect(native.setAccount).toHaveBeenLastCalledWith("work", "work@example.test");
    expect(native.setSettings).toHaveBeenLastCalledWith(
      DEFAULT_LIVE_NOTIFICATION_SETTINGS,
      endpoint,
      "work-token",
      "shared-space",
      "de",
      "",
    );
    await resumeLiveNotifications(endpoint, "family-token", "shared-space");
    expect(native.setSettings).toHaveBeenLastCalledWith(
      family,
      endpoint,
      "family-token",
      "shared-space",
      "de",
      "",
    );
    expect(native.resume).not.toHaveBeenCalled();
  });

  it("keeps a legacy login polling before its account is saved", async () => {
    await resumeLiveNotifications(endpoint, "family-token", "space-1");
    expect(native.setAccount).toHaveBeenCalledWith("", "");
    expect(native.resume).toHaveBeenCalled();
  });

  it("pauses for a bearer that is not one of the saved accounts", async () => {
    await rememberSavedAccount(endpoint, account("family"));
    await resumeLiveNotifications(endpoint, "unknown-token", "space-1");
    expect(native.stop).toHaveBeenCalledWith(false);
    expect(native.setAccount).not.toHaveBeenCalled();
    expect(native.resume).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "pauses when account ownership cannot be read (new native: %s)",
    async (modern) => {
      if (!modern) native.setAccount = undefined;
      vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("locked"));
      await resumeLiveNotifications(endpoint, "work-token", "space-1");
      expect(native.stop).toHaveBeenCalledWith(false);
      expect(native.resume).not.toHaveBeenCalled();
      expect(native.setSettings).not.toHaveBeenCalled();
    },
  );

  it("keeps an older binary working with one saved account and pauses it with several", async () => {
    native.setAccount = undefined;
    await rememberSavedAccount(endpoint, account("family"));
    await resumeLiveNotifications(endpoint, "family-token", "space-1");
    expect(native.resume).toHaveBeenCalledWith(endpoint, "family-token", "space-1", "de", "");
    native.resume.mockClear();
    await rememberSavedAccount(endpoint, account("work"));
    await resumeLiveNotifications(endpoint, "family-token", "space-1");
    expect(native.stop).toHaveBeenCalledWith(false);
    expect(native.resume).not.toHaveBeenCalled();
  });

  it("keeps other logins' alerts when an older binary signs one out", async () => {
    native.setAccount = undefined;
    await stopLiveNotifications(true);
    expect(native.stop).toHaveBeenLastCalledWith(true);
    await rememberSavedAccount(endpoint, account("work"));
    await stopLiveNotifications(true);
    expect(native.stop).toHaveBeenLastCalledWith(false);
  });
});

describe("Android sign-out", () => {
  it("leaves clearing delivered notifications to the native service", async () => {
    await stopLiveNotifications(true);
    expect(native.stop).toHaveBeenCalledWith(true);
    expect(Notifications.dismissAllNotificationsAsync).not.toHaveBeenCalled();
  });
});

describe("Android open thread", () => {
  beforeEach(() => {
    native.setOpenThread.mockReset();
    native.setOpenThread.mockImplementation(async () => undefined);
    vi.resetModules();
  });

  async function openThread() {
    return import("./live-notifications");
  }

  it("tells the native poller only when the open thread changes", async () => {
    const { setOpenNotificationThread } = await openThread();
    const thread = { botId: "bot-1", threadId: "thread-1" };
    await setOpenNotificationThread(thread);
    await setOpenNotificationThread({ ...thread });
    await setOpenNotificationThread({ ...thread });
    expect(native.setOpenThread).toHaveBeenCalledTimes(1);

    await setOpenNotificationThread(null);
    await setOpenNotificationThread(null);
    await setOpenNotificationThread({ botId: "bot-2", threadId: "thread-2" });
    expect(native.setOpenThread.mock.calls).toEqual([
      ["bot-1", "thread-1"],
      [null, null],
      ["bot-2", "thread-2"],
    ]);
  });

  it("retries an identical report after the native update rejects", async () => {
    const { setOpenNotificationThread } = await openThread();
    const thread = { botId: "bot-1", threadId: "thread-1" };
    native.setOpenThread.mockRejectedValueOnce(new Error("poller failed"));
    await expect(setOpenNotificationThread(thread)).rejects.toThrow("poller failed");
    await setOpenNotificationThread(thread);
    expect(native.setOpenThread.mock.calls).toEqual([
      ["bot-1", "thread-1"],
      ["bot-1", "thread-1"],
    ]);
  });

  it("retries thread A after overlapping reports both reject", async () => {
    const { setOpenNotificationThread } = await openThread();
    const threadA = { botId: "bot-a", threadId: "thread-a" };
    const threadB = { botId: "bot-b", threadId: "thread-b" };
    let rejectA!: (error: Error) => void;
    let rejectB!: (error: Error) => void;
    native.setOpenThread
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            rejectA = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            rejectB = reject;
          }),
      );

    const reportA = setOpenNotificationThread(threadA);
    const reportB = setOpenNotificationThread(threadB);
    const asserted = Promise.all([
      expect(reportA).rejects.toThrow("a failed"),
      expect(reportB).rejects.toThrow("b failed"),
    ]);
    rejectA(new Error("a failed"));
    rejectB(new Error("b failed"));
    await asserted;

    await setOpenNotificationThread(threadA);
    expect(native.setOpenThread.mock.calls).toEqual([
      ["bot-a", "thread-a"],
      ["bot-b", "thread-b"],
      ["bot-a", "thread-a"],
    ]);
  });

  it("ignores an older confirmation that resolves after a newer report", async () => {
    const { setOpenNotificationThread } = await openThread();
    const threadA = { botId: "bot-a", threadId: "thread-a" };
    const threadB = { botId: "bot-b", threadId: "thread-b" };
    let resolveA!: () => void;
    native.setOpenThread.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveA = resolve;
        }),
    );

    const reportA = setOpenNotificationThread(threadA);
    await setOpenNotificationThread(threadB);
    resolveA();
    await reportA;

    await setOpenNotificationThread(threadA);
    expect(native.setOpenThread.mock.calls).toEqual([
      ["bot-a", "thread-a"],
      ["bot-b", "thread-b"],
      ["bot-a", "thread-a"],
    ]);
  });

  it("reports a close after a newer report rejects and an older report succeeds", async () => {
    const { setOpenNotificationThread } = await openThread();
    await setOpenNotificationThread(null);
    let resolveA!: () => void;
    let rejectB!: (error: Error) => void;
    native.setOpenThread
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            rejectB = reject;
          }),
      );

    const reportA = setOpenNotificationThread({ botId: "bot-a", threadId: "thread-a" });
    const reportB = setOpenNotificationThread({ botId: "bot-b", threadId: "thread-b" });
    const rejected = expect(reportB).rejects.toThrow("b failed");
    rejectB(new Error("b failed"));
    await rejected;
    resolveA();
    await reportA;

    await setOpenNotificationThread(null);
    expect(native.setOpenThread.mock.calls).toEqual([
      [null, null],
      ["bot-a", "thread-a"],
      ["bot-b", "thread-b"],
      [null, null],
    ]);
  });

  it("reports the initial closed thread once", async () => {
    const { setOpenNotificationThread } = await openThread();
    await setOpenNotificationThread(null);
    await setOpenNotificationThread(null);
    expect(native.setOpenThread).toHaveBeenCalledTimes(1);
    expect(native.setOpenThread).toHaveBeenCalledWith(null, null);
  });

  it("reports a close while an open report is still pending after a confirmed close", async () => {
    const { setOpenNotificationThread } = await openThread();
    await setOpenNotificationThread(null);
    let resolveOpen!: () => void;
    native.setOpenThread.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveOpen = resolve;
        }),
    );

    const opening = setOpenNotificationThread({ botId: "bot-a", threadId: "thread-a" });
    await setOpenNotificationThread(null);
    expect(native.setOpenThread.mock.calls).toEqual([
      [null, null],
      ["bot-a", "thread-a"],
      [null, null],
    ]);

    resolveOpen();
    await opening;
  });
});
