import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const native = vi.hoisted(() => ({
  apiBase: "https://chat.example.test",
  alert: vi.fn(),
  openUrl: vi.fn(async (_url: string) => undefined),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
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

async function load() {
  const support = await import("./self-hosted-support");
  support.resetSelfHostedSupportForTests();
  return support;
}

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
  });

  it("asks once per device and opens the chosen payment page", async () => {
    const support = await load();
    await support.offerSelfHostedSupportOnce(() => true);
    expect(native.alert).toHaveBeenCalledTimes(1);

    buttons()[1]?.onPress?.();
    expect(native.openUrl).toHaveBeenCalledWith("https://rakazo.com/priority-support");

    support.resetSelfHostedSupportForTests();
    await support.offerSelfHostedSupportOnce(() => true);
    expect(native.alert).toHaveBeenCalledTimes(1);
  });

  it("never asks on the hosted server", async () => {
    native.apiBase = "https://app.example.test";
    const support = await load();
    await support.offerSelfHostedSupportOnce(() => true);
    expect(native.alert).not.toHaveBeenCalled();
    expect(support.selfHosted()).toBe(false);
  });

  it("waits for the next inbox visit when the inbox has gone", async () => {
    const support = await load();
    await support.offerSelfHostedSupportOnce(() => false);
    expect(native.alert).not.toHaveBeenCalled();

    await support.offerSelfHostedSupportOnce(() => true);
    expect(native.alert).toHaveBeenCalledTimes(1);
  });
});
