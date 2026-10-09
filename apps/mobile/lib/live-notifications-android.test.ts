import { beforeEach, describe, expect, it, vi } from "vitest";

const { native } = vi.hoisted(() => ({ native: { setOpenThread: vi.fn(async () => undefined) } }));

vi.mock("expo-modules-core", () => ({ requireNativeModule: () => native }));
vi.mock("expo-notifications", () => ({ setNotificationHandler: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

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

  it("reports the initial closed thread once", async () => {
    const { setOpenNotificationThread } = await openThread();
    await setOpenNotificationThread(null);
    await setOpenNotificationThread(null);
    expect(native.setOpenThread).toHaveBeenCalledTimes(1);
    expect(native.setOpenThread).toHaveBeenCalledWith(null, null);
  });
});
