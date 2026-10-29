import { beforeEach, describe, expect, it, vi } from "vitest";

const { native, platform } = vi.hoisted(() => ({
  native: {} as { hasPromotedSettings?: () => boolean },
  platform: { OS: "android", Version: 36 as number | string },
}));

vi.mock("expo-modules-core", () => ({ requireNativeModule: () => native }));
vi.mock("expo-notifications", () => ({ setNotificationHandler: vi.fn() }));
vi.mock("react-native", () => ({ Platform: platform }));

describe("Live update settings row", () => {
  beforeEach(() => {
    delete native.hasPromotedSettings;
    platform.OS = "android";
    platform.Version = 36;
    vi.resetModules();
  });

  async function load() {
    return import("./live-notifications");
  }

  it("is hidden before Android 16, where the screen does not exist", async () => {
    platform.Version = 35;
    const { hasLiveUpdateSettings } = await load();
    expect(hasLiveUpdateSettings()).toBe(false);
  });

  it("is shown on Android 16 when the native build cannot say", async () => {
    const { hasLiveUpdateSettings } = await load();
    expect(hasLiveUpdateSettings()).toBe(true);
  });

  it("trusts the native check that the screen resolves", async () => {
    native.hasPromotedSettings = () => false;
    const { hasLiveUpdateSettings } = await load();
    expect(hasLiveUpdateSettings()).toBe(false);
  });

  it("is hidden off Android", async () => {
    platform.OS = "ios";
    platform.Version = "26.0";
    const { hasLiveUpdateSettings } = await load();
    expect(hasLiveUpdateSettings()).toBe(false);
  });
});
