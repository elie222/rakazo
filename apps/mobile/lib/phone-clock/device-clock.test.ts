import type { NativeClockOperation } from "@rakazo/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { prepareDeviceClock } from "./device-clock";

const native = vi.hoisted(() => ({
  platform: { OS: "android" },
  appState: { currentState: "active" },
  confirm: vi.fn(),
  clock: { startTimer: vi.fn(), setAlarm: vi.fn() },
  module: vi.fn(),
}));

vi.mock("react-native", () => ({
  AppState: native.appState,
  Platform: native.platform,
}));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: native.module }));
vi.mock("../i18n/i18n", () => ({ dateLocaleForUi: () => "en-US" }));

const timer: NativeClockOperation = {
  action: "start_phone_timer",
  input: { durationSeconds: 95, label: "Tea" },
};
const alarm: NativeClockOperation = {
  action: "set_phone_alarm",
  input: { hour: 0, minute: 45 },
};

beforeEach(() => {
  vi.resetAllMocks();
  native.platform.OS = "android";
  native.appState.currentState = "active";
  native.module.mockReturnValue(native.clock);
  native.confirm.mockResolvedValue(true);
});

it("requires a supported native build and foreground chat before asking", async () => {
  native.module.mockReturnValue(null);
  expect(await prepareDeviceClock(timer, () => true, native.confirm)).toEqual({
    status: "unavailable",
  });

  native.module.mockReturnValue(native.clock);
  native.platform.OS = "ios";
  expect(await prepareDeviceClock(timer, () => true, native.confirm)).toEqual({
    status: "unavailable",
  });

  native.platform.OS = "android";
  expect(await prepareDeviceClock(timer, () => false, native.confirm)).toEqual({
    status: "unavailable",
  });
  native.appState.currentState = "background";
  expect(await prepareDeviceClock(timer, () => true, native.confirm)).toEqual({
    status: "unavailable",
  });
  expect(native.confirm).not.toHaveBeenCalled();
});

it("rejects an invalid operation and does not dispatch a dismissed one", async () => {
  const invalidTimer: NativeClockOperation = {
    action: "start_phone_timer",
    input: { durationSeconds: 1.5 },
  };
  expect(await prepareDeviceClock(invalidTimer, () => true, native.confirm)).toEqual({
    status: "unavailable",
  });
  expect(native.confirm).not.toHaveBeenCalled();

  native.confirm.mockResolvedValue(false);
  expect(await prepareDeviceClock(timer, () => true, native.confirm)).toEqual({
    status: "cancelled",
  });
  expect(native.clock.startTimer).not.toHaveBeenCalled();
});

it("previews the exact timer and preserves the dispatch receipt when Clock takes foreground", async () => {
  native.clock.startTimer.mockImplementation(async () => {
    native.appState.currentState = "background";
    return "dispatched";
  });
  const prepared = await prepareDeviceClock(timer, () => true, native.confirm);
  expect(native.confirm.mock.calls[0]?.[0].message).toBe("1 min 35 sec\nTea");
  expect(native.clock.startTimer).not.toHaveBeenCalled();
  if (!("perform" in prepared)) throw new Error("Expected a prepared timer");
  expect(await prepared.perform()).toEqual({ status: "dispatched" });
  expect(native.clock.startTimer).toHaveBeenCalledExactlyOnceWith(95, "Tea");
});

it("drops a prepared request when its chat changes before dispatch", async () => {
  let current = true;
  const prepared = await prepareDeviceClock(alarm, () => current, native.confirm);
  if (!("perform" in prepared)) throw new Error("Expected a prepared alarm");
  current = false;
  expect(await prepared.perform()).toEqual({ status: "unavailable" });
  expect(native.clock.setAlarm).not.toHaveBeenCalled();
});

it.each(["unavailable", "uncertain"])("preserves the native alarm outcome %s", async (status) => {
  native.clock.setAlarm.mockResolvedValue(status);
  const prepared = await prepareDeviceClock(alarm, () => true, native.confirm);
  expect(native.confirm.mock.calls[0]?.[0].message).toBe("12:45 AM");
  if (!("perform" in prepared)) throw new Error("Expected a prepared alarm");
  expect(await prepared.perform()).toEqual({ status });
  expect(native.clock.setAlarm).toHaveBeenCalledExactlyOnceWith(0, 45, null);
});

it("passes unexpected native exceptions to the shared execution reporter", async () => {
  const nativeFailure = new Error("test-only bridge fault");
  native.clock.startTimer.mockRejectedValue(nativeFailure);
  const prepared = await prepareDeviceClock(timer, () => true, native.confirm);
  if (!("perform" in prepared)) throw new Error("Expected a prepared timer");

  await expect(prepared.perform()).rejects.toBe(nativeFailure);
});
