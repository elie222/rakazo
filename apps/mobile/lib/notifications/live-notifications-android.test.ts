import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { native } = vi.hoisted(() => ({
  native: {
    setOpenThread: vi.fn(async (): Promise<void> => undefined),
    resume: vi.fn(async (): Promise<void> => undefined),
    resumeAfterMute: vi.fn(async (): Promise<void> => undefined),
    stop: vi.fn(async (): Promise<void> => undefined),
  },
}));

vi.mock("expo-modules-core", () => ({ requireNativeModule: () => native }));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  dismissAllNotificationsAsync: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("../i18n/i18n", () => ({ getActiveUiLocale: () => "de" }));
const store = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void store.set(key, value),
  deleteItemAsync: async (key: string) => void store.delete(key),
}));

import * as Notifications from "expo-notifications";
import { saveServerHeaders } from "../api/server-headers";
import {
  afterChatNotifyChange,
  resumeLiveNotifications,
  stopLiveNotifications,
} from "./live-notifications";

describe("Android live notification resume", () => {
  beforeEach(() => {
    native.resume.mockReset();
    native.resumeAfterMute.mockClear();
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
    await expect(
      resumeLiveNotifications("http://app.example.test", "token-1", "space-1"),
    ).resolves.toBe(false);
    await expect(resumeLiveNotifications("not a url", "token-1", "space-1")).resolves.toBe(false);
    await expect(resumeLiveNotifications("https://app.example.test", "", "space-1")).resolves.toBe(
      false,
    );
    expect(native.resume).not.toHaveBeenCalled();
  });

  it("reports that the native module now keeps the session", async () => {
    await expect(
      resumeLiveNotifications("https://app.example.test", "token-1", "space-1"),
    ).resolves.toBe(true);
  });

  it("passes the muted bot to the native restart even without a thread id", async () => {
    await afterChatNotifyChange("https://app.example.test", "token-1", "space-1", {
      botId: "bot-1",
      notify: false,
    });
    expect(native.resumeAfterMute).toHaveBeenCalledExactlyOnceWith(
      "https://app.example.test",
      "token-1",
      "space-1",
      "de",
      "",
      "bot-1",
    );
    expect(native.resume).not.toHaveBeenCalled();
  });

  it("keeps pending replies when notifications are turned on", async () => {
    await afterChatNotifyChange("https://app.example.test", "token-1", "space-1", {
      botId: "bot-1",
      notify: true,
    });
    expect(native.resumeAfterMute).not.toHaveBeenCalled();
    expect(native.resume).toHaveBeenCalled();
  });

  it("keeps the existing resume path on older native builds", async () => {
    const resumeAfterMute = native.resumeAfterMute;
    Reflect.deleteProperty(native, "resumeAfterMute");
    try {
      await afterChatNotifyChange("https://app.example.test", "token-1", "space-1", {
        botId: "bot-1",
        notify: false,
      });
      expect(native.resume).toHaveBeenCalledExactlyOnceWith(
        "https://app.example.test",
        "token-1",
        "space-1",
        "de",
        "",
      );
    } finally {
      native.resumeAfterMute = resumeAfterMute;
    }
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
    let rejectA!: Deferred;
    let rejectB!: Deferred;
    native.setOpenThread
      .mockImplementationOnce(() => {
        rejectA = deferred();
        return rejectA.promise;
      })
      .mockImplementationOnce(() => {
        rejectB = deferred();
        return rejectB.promise;
      });

    const reportA = setOpenNotificationThread(threadA);
    const reportB = setOpenNotificationThread(threadB);
    const asserted = Promise.all([
      expect(reportA).rejects.toThrow("a failed"),
      expect(reportB).rejects.toThrow("b failed"),
    ]);
    rejectA.reject(new Error("a failed"));
    rejectB.reject(new Error("b failed"));
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
    let resolveA!: Deferred;
    native.setOpenThread.mockImplementationOnce(() => {
      resolveA = deferred();
      return resolveA.promise;
    });

    const reportA = setOpenNotificationThread(threadA);
    await setOpenNotificationThread(threadB);
    resolveA.resolve();
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
    let resolveA!: Deferred;
    let rejectB!: Deferred;
    native.setOpenThread
      .mockImplementationOnce(() => {
        resolveA = deferred();
        return resolveA.promise;
      })
      .mockImplementationOnce(() => {
        rejectB = deferred();
        return rejectB.promise;
      });

    const reportA = setOpenNotificationThread({ botId: "bot-a", threadId: "thread-a" });
    const reportB = setOpenNotificationThread({ botId: "bot-b", threadId: "thread-b" });
    const rejected = expect(reportB).rejects.toThrow("b failed");
    rejectB.reject(new Error("b failed"));
    await rejected;
    resolveA.resolve();
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
    let resolveOpen!: Deferred;
    native.setOpenThread.mockImplementationOnce(() => {
      resolveOpen = deferred();
      return resolveOpen.promise;
    });

    const opening = setOpenNotificationThread({ botId: "bot-a", threadId: "thread-a" });
    await setOpenNotificationThread(null);
    expect(native.setOpenThread.mock.calls).toEqual([
      [null, null],
      ["bot-a", "thread-a"],
      [null, null],
    ]);

    resolveOpen.resolve();
    await opening;
  });
});
