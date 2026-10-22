import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { native, platform } = vi.hoisted(() => ({
  native: {} as { hasPromotedSettings?: () => boolean },
  platform: { OS: "android", Version: 36 as number | string },
}));

vi.mock("expo-modules-core", () => ({ requireNativeModule: () => native }));
vi.mock("expo-notifications", () => ({ setNotificationHandler: vi.fn() }));
vi.mock("react-native", () => ({ Platform: platform }));

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

  it("only renders the row when the screen exists, and checks it natively", () => {
    const account = readFileSync(resolve(mobileRoot, "app/(settings)/account.tsx"), "utf8");
    expect(account).toMatch(
      /hasLiveUpdateSettings\(\)[\s\S]{0,40}\? \([\s\S]{0,40}<SettingsRow[\s\S]{0,120}openPromotedNotificationSettings[\s\S]{0,80}t\("Live update settings"\)/,
    );
    const nativeRoot = resolve(mobileRoot, "modules/rakazo-notifications/android/src/main");
    const module = readFileSync(
      resolve(nativeRoot, "java/com/rakazo/notifications/RakazoNotificationsModule.kt"),
      "utf8",
    );
    expect(module).toMatch(/Function\("hasPromotedSettings"\)[\s\S]*resolveActivity/);
    const manifest = readFileSync(resolve(nativeRoot, "AndroidManifest.xml"), "utf8");
    expect(manifest).toMatch(
      /<queries>[\s\S]*android\.settings\.APP_NOTIFICATION_PROMOTION_SETTINGS[\s\S]*<\/queries>/,
    );
  });
});
