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
import {
  forgetSavedToken,
  loadSavedAccounts,
  rememberSavedAccount,
  setSelectedSavedAccount,
} from "./saved-accounts";
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
  setSelectedSavedAccount(null);
});

const endpoint = "https://app.example.test";
const account = (userId: string) => ({
  userId,
  token: `${userId}-token`,
  name: userId,
  email: `${userId}@example.test`,
  image: null,
  unread: 0,
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
  it("adopts genuine legacy preferences once and preserves them when switching back", async () => {
    native.setAccount = vi.fn(async () => undefined);
    const legacy = {
      liveConnection: false,
      messages: false,
      scheduledTasks: false,
      needsAttention: false,
    };
    native.getSettings.mockResolvedValue(legacy);
    await rememberSavedAccount(endpoint, account("family"));
    setSelectedSavedAccount({ apiBase: endpoint, userId: "family" });
    await resumeLiveNotifications(endpoint, "family-token", "shared-space");
    expect((await loadSavedAccounts(endpoint))[0]?.notifications).toEqual(legacy);

    await rememberSavedAccount(endpoint, {
      ...account("work"),
      notifications: DEFAULT_LIVE_NOTIFICATION_SETTINGS,
    });
    setSelectedSavedAccount({ apiBase: endpoint, userId: "work" });
    await resumeLiveNotifications(endpoint, "work-token", "shared-space");
    expect(native.setSettings).toHaveBeenLastCalledWith(
      DEFAULT_LIVE_NOTIFICATION_SETTINGS,
      endpoint,
      "work-token",
      "shared-space",
      "de",
      "",
    );
    setSelectedSavedAccount({ apiBase: endpoint, userId: "family" });
    await resumeLiveNotifications(endpoint, "family-token", "shared-space");
    expect(native.setSettings).toHaveBeenLastCalledWith(
      legacy,
      endpoint,
      "family-token",
      "shared-space",
      "de",
      "",
    );
  });

  it.each([false, true])(
    "uses a new account's defaults after another account signs out (new native: %s)",
    async (modern) => {
      if (modern) native.setAccount = vi.fn(async () => undefined);
      const old = {
        liveConnection: false,
        messages: false,
        scheduledTasks: false,
        needsAttention: false,
      };
      native.getSettings.mockResolvedValue(old);
      await rememberSavedAccount(endpoint, { ...account("family"), notifications: old });
      setSelectedSavedAccount({ apiBase: endpoint, userId: "family" });
      await stopLiveNotifications(true);
      await forgetSavedToken(endpoint, "family-token");
      await rememberSavedAccount(endpoint, {
        ...account("work"),
        notifications: DEFAULT_LIVE_NOTIFICATION_SETTINGS,
      });
      setSelectedSavedAccount({ apiBase: endpoint, userId: "work" });
      await resumeLiveNotifications(endpoint, "work-token", "space-1");
      expect(native.setSettings).toHaveBeenLastCalledWith(
        DEFAULT_LIVE_NOTIFICATION_SETTINGS,
        endpoint,
        "work-token",
        "space-1",
        "de",
        "",
      );
      expect(native.getSettings).not.toHaveBeenCalled();
      expect(native.resume).not.toHaveBeenCalled();
    },
  );
  it("pauses a new native build until the bearer has a verified saved account", async () => {
    native.setAccount = vi.fn(async () => undefined);
    await resumeLiveNotifications(endpoint, "work-token", "space-1");
    expect(native.stop).toHaveBeenCalledWith(false);
    expect(native.resume).not.toHaveBeenCalled();
    expect(native.setAccount).not.toHaveBeenCalled();
    expect(native.setSettings).not.toHaveBeenCalled();

    await rememberSavedAccount(endpoint, account("work"));
    await resumeLiveNotifications(endpoint, "work-token", "space-1");
    expect(native.setAccount).toHaveBeenCalledWith("work", "work@example.test");
    expect(native.setSettings).toHaveBeenCalledWith(
      DEFAULT_LIVE_NOTIFICATION_SETTINGS,
      endpoint,
      "work-token",
      "space-1",
      "de",
      "",
    );
    expect(native.resume).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "pauses when account ownership cannot be read (new native: %s)",
    async (modern) => {
      if (modern) native.setAccount = vi.fn(async () => undefined);
      vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("locked"));
      await resumeLiveNotifications(endpoint, "work-token", "space-1");
      expect(native.stop).toHaveBeenCalledWith(false);
      expect(native.resume).not.toHaveBeenCalled();
      expect(native.setSettings).not.toHaveBeenCalled();
    },
  );

  it("restores each account's own label and notification preferences in a shared Space", async () => {
    native.setAccount = vi.fn(async () => undefined);
    const family = { ...DEFAULT_LIVE_NOTIFICATION_SETTINGS, liveConnection: true, messages: false };
    const work = { ...DEFAULT_LIVE_NOTIFICATION_SETTINGS, needsAttention: false };
    await rememberSavedAccount(endpoint, { ...account("family"), notifications: family });
    await rememberSavedAccount(endpoint, { ...account("work"), notifications: work });
    setSelectedSavedAccount({ apiBase: endpoint, userId: "family" });
    await resumeLiveNotifications(endpoint, "family-token", "shared-space");
    expect(native.setAccount).toHaveBeenLastCalledWith("family", "family@example.test");
    expect(native.setSettings).toHaveBeenLastCalledWith(
      family,
      endpoint,
      "family-token",
      "shared-space",
      "de",
      "",
    );
    setSelectedSavedAccount({ apiBase: endpoint, userId: "work" });
    await resumeLiveNotifications(endpoint, "work-token", "shared-space");
    expect(native.setAccount).toHaveBeenLastCalledWith("work", "work@example.test");
    expect(native.setSettings).toHaveBeenLastCalledWith(
      work,
      endpoint,
      "work-token",
      "shared-space",
      "de",
      "",
    );
    expect(native.resume).not.toHaveBeenCalled();
  });

  it("does not pause a replacement account when an older ownership read fails", async () => {
    native.setAccount = vi.fn(async () => undefined);
    let reject!: (error: Error) => void;
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const resuming = resumeLiveNotifications(endpoint, "family-token", "space-1");
    await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
    setSelectedSavedAccount({ apiBase: endpoint, userId: "work" });
    reject(new Error("locked"));
    await resuming;
    expect(native.stop).not.toHaveBeenCalled();
    expect(native.resume).not.toHaveBeenCalled();
  });

  it("keeps an older binary working with one saved account and pauses it with several", async () => {
    await rememberSavedAccount(endpoint, account("family"));
    await resumeLiveNotifications(endpoint, "family-token", "space-1");
    expect(native.resume).toHaveBeenCalledWith(endpoint, "family-token", "space-1", "de", "");
    native.resume.mockClear();
    await rememberSavedAccount(endpoint, account("work"));
    await resumeLiveNotifications(endpoint, "family-token", "space-1");
    expect(native.stop).toHaveBeenCalledWith(false);
    expect(native.resume).not.toHaveBeenCalled();
  });

  it("does not apply settings under an unverified native identity", async () => {
    native.setAccount = vi.fn(async () => undefined);
    await setLiveNotificationSettings(
      DEFAULT_LIVE_NOTIFICATION_SETTINGS,
      endpoint,
      "unknown-token",
      "space-1",
    );
    expect(native.stop).toHaveBeenCalledWith(false);
    expect(native.setAccount).not.toHaveBeenCalled();
    expect(native.setSettings).not.toHaveBeenCalled();
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
