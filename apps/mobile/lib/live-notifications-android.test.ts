import { describe, expect, it, vi } from "vitest";

const { native } = vi.hoisted(() => ({ native: { setOpenThread: vi.fn(async () => undefined) } }));

vi.mock("expo-modules-core", () => ({ requireNativeModule: () => native }));
vi.mock("expo-notifications", () => ({ setNotificationHandler: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

import { setOpenNotificationThread } from "./live-notifications";

describe("Android open thread", () => {
  it("tells the native poller only when the open thread changes", async () => {
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
});
