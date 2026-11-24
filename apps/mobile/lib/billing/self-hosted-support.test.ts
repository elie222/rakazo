import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  offerSelfHostedSupportOnce,
  resetSelfHostedSupportForTests,
  selfHosted,
} from "./self-hosted-support";

const store = new Map<string, string>();
const fail = vi.hoisted(() => ({ read: false }));
const native = vi.hoisted(() => ({
  apiBase: "https://chat.example.test",
  alert: vi.fn(),
  openUrl: vi.fn(async (_url: string) => undefined),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => {
    if (fail.read) throw new Error("keychain locked");
    return store.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
}));
vi.mock("react-native", () => ({ Alert: { alert: native.alert } }));
vi.mock("../api/api", () => ({ currentApiBase: () => native.apiBase }));
vi.mock("../api/endpoint", () => ({
  usesCustomApiBase: (url: string) => url !== "https://app.example.test",
}));
vi.mock("../platform/open-url", () => ({ openExternalUrl: native.openUrl }));

type Button = { text: string; onPress?: () => void };
function buttons(): Button[] {
  return native.alert.mock.calls.at(-1)?.[2] as Button[];
}

describe("self-hosted support offer", () => {
  beforeEach(() => {
    store.clear();
    native.alert.mockClear();
    native.openUrl.mockClear();
    native.apiBase = "https://chat.example.test";
    fail.read = false;
    resetSelfHostedSupportForTests();
  });

  it("asks once per device and opens the chosen payment page", async () => {
    await offerSelfHostedSupportOnce(() => true);
    expect(native.alert).toHaveBeenCalledTimes(1);

    buttons()[1]?.onPress?.();
    expect(native.openUrl).toHaveBeenCalledWith("https://rakazo.com/priority-support");

    resetSelfHostedSupportForTests();
    await offerSelfHostedSupportOnce(() => true);
    expect(native.alert).toHaveBeenCalledTimes(1);
  });

  it("never asks on the hosted server", async () => {
    native.apiBase = "https://app.example.test";
    await offerSelfHostedSupportOnce(() => true);
    expect(native.alert).not.toHaveBeenCalled();
    expect(selfHosted()).toBe(false);
  });

  it("waits for the next inbox visit when the inbox has gone", async () => {
    await offerSelfHostedSupportOnce(() => false);
    expect(native.alert).not.toHaveBeenCalled();

    await offerSelfHostedSupportOnce(() => true);
    expect(native.alert).toHaveBeenCalledTimes(1);
  });

  it("leaves the offer for a later visit when the read fails", async () => {
    fail.read = true;
    await expect(offerSelfHostedSupportOnce(() => true)).resolves.toBe(false);
    expect(native.alert).not.toHaveBeenCalled();

    fail.read = false;
    await expect(offerSelfHostedSupportOnce(() => true)).resolves.toBe(true);
    expect(native.alert).toHaveBeenCalledTimes(1);
  });
});
