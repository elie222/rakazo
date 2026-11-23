import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  startCall: vi.fn(async () => true),
  stopCall: vi.fn(async () => undefined),
}));

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: () => native,
}));

import { startCallBackground, stopCallBackground } from "./call-background";

beforeEach(() => {
  native.startCall.mockClear();
  native.stopCall.mockClear();
});

describe("call background service bridge", () => {
  it("starts and stops the native call service", async () => {
    await expect(startCallBackground("Ada")).resolves.toBe(true);
    await stopCallBackground();

    expect(native.startCall).toHaveBeenCalledWith("Ada");
    expect(native.stopCall).toHaveBeenCalledOnce();
  });

  it("swallows native start/stop failures", async () => {
    native.startCall.mockRejectedValueOnce(new Error("not allowed"));
    native.stopCall.mockRejectedValueOnce(new Error("not running"));

    await expect(startCallBackground("Ada")).resolves.toBe(false);
    await expect(stopCallBackground()).resolves.toBeUndefined();
  });
});
