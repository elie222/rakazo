import * as SecureStore from "expo-secure-store";
import { Alert } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../api/api";
import { checkDeviceTimezone, resetDeviceTimezoneForTests } from "./device-timezone";

const device = vi.hoisted(() => ({ zone: "Asia/Tokyo" as string | undefined }));
vi.mock("../routines/routine", () => ({ deviceTimeZone: () => device.zone }));
const stored = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => stored.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => void stored.set(key, value)),
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("../api/api", () => ({ rpc: vi.fn(async () => ({})) }));

type Button = { text: string; onPress?: () => void };
const active = () => true;

function lastPrompt() {
  const call = vi.mocked(Alert.alert).mock.calls.at(-1);
  const buttons = (call?.[2] ?? []) as Button[];
  const press = (text: string) => buttons.find((button) => button.text === text)?.onPress?.();
  return { title: call?.[0], press };
}

beforeEach(() => {
  device.zone = "Asia/Tokyo";
  stored.clear();
  resetDeviceTimezoneForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

it("fills an empty account zone with the device's once", async () => {
  await checkDeviceTimezone("user-1", null, active);
  await checkDeviceTimezone("user-1", null, active);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith("preferences/adoptTimezone", { timezone: "Asia/Tokyo" });
  expect(Alert.alert).not.toHaveBeenCalled();
});

it("does nothing while the account uses the device zone", async () => {
  await checkDeviceTimezone("user-1", "Asia/Tokyo", active);
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});

it("asks once when the zones differ and switches on Switch", async () => {
  await checkDeviceTimezone("user-1", "Europe/London", active);
  await checkDeviceTimezone("user-1", "Europe/London", active);
  expect(Alert.alert).toHaveBeenCalledTimes(1);
  expect(lastPrompt().title).toBe("Switch to Tokyo time?");
  lastPrompt().press("Switch");
  expect(rpc).toHaveBeenCalledWith("preferences/update", { timezone: "Asia/Tokyo" });
});

it("remembers Keep for that device zone and asks again in another", async () => {
  await checkDeviceTimezone("user-1", "Europe/London", active);
  lastPrompt().press("Keep");
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
    "rakazo.timezone-kept.user-1",
    JSON.stringify({ device: "Asia/Tokyo", account: "Europe/London" }),
  );

  resetDeviceTimezoneForTests();
  await checkDeviceTimezone("user-1", "Europe/London", active);
  expect(Alert.alert).toHaveBeenCalledTimes(1);

  device.zone = "America/New_York";
  await checkDeviceTimezone("user-1", "Europe/London", active);
  expect(Alert.alert).toHaveBeenCalledTimes(2);
  expect(lastPrompt().title).toBe("Switch to New York time?");
});

it("does not ask for a session that is no longer shown", async () => {
  await checkDeviceTimezone("user-1", "Europe/London", () => false);
  expect(Alert.alert).not.toHaveBeenCalled();
});

it("retries an adoption that failed", async () => {
  vi.mocked(rpc).mockRejectedValueOnce(new Error("offline"));
  await expect(checkDeviceTimezone("user-1", null, active)).rejects.toThrow("offline");
  await checkDeviceTimezone("user-1", null, active);
  expect(rpc).toHaveBeenCalledTimes(2);
});

it("switches nothing once the session that asked is gone", async () => {
  let shown = true;
  await checkDeviceTimezone("user-1", "Europe/London", () => shown);
  shown = false;
  lastPrompt().press("Switch");
  expect(rpc).not.toHaveBeenCalled();
});

it("still checks another account while one account's question is open", async () => {
  await checkDeviceTimezone("user-1", "Europe/London", active);
  await checkDeviceTimezone("user-2", null, active);
  expect(rpc).toHaveBeenCalledWith("preferences/adoptTimezone", { timezone: "Asia/Tokyo" });
});

it("leaves the account alone when the device names no zone", async () => {
  device.zone = undefined;
  await checkDeviceTimezone("user-1", null, active);
  await checkDeviceTimezone("user-1", "Asia/Kolkata", active);
  expect(rpc).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
});
