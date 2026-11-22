import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type ConfigPlugin = string | [string, Record<string, unknown>];

type MobileAppConfig = {
  expo: {
    plugins: ConfigPlugin[];
    android: { blockedPermissions?: string[] };
    locales: Record<string, string>;
  };
};

function readMobileAppConfig(): MobileAppConfig {
  const path = resolve(import.meta.dirname, "..", "..", "app.json");
  return JSON.parse(readFileSync(path, "utf8")) as MobileAppConfig;
}

describe("Android permission config", () => {
  it("does not block microphone permission through expo-image-picker", () => {
    const plugins = readMobileAppConfig().expo.plugins;
    const imagePicker = plugins.find(
      (plugin): plugin is [string, Record<string, unknown>] =>
        Array.isArray(plugin) && plugin[0] === "expo-image-picker",
    );

    expect(imagePicker).toBeDefined();
    expect(typeof imagePicker?.[1].microphonePermission).toBe("string");
    expect(imagePicker?.[1].microphonePermission).not.toBe("");
  });

  it("asks for add-only photo library access with explicit copy", () => {
    const { plugins, android } = readMobileAppConfig().expo;
    const mediaLibrary = plugins.find(
      (plugin): plugin is [string, Record<string, unknown>] =>
        Array.isArray(plugin) && plugin[0] === "expo-media-library",
    );

    expect(mediaLibrary).toBeDefined();
    expect(typeof mediaLibrary?.[1].savePhotosPermission).toBe("string");
    expect(mediaLibrary?.[1].savePhotosPermission).not.toBe("");
    expect(mediaLibrary?.[1].granularPermissions).toEqual([]);
    expect(android.blockedPermissions).toContain(
      "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
    );
  });

  it("translates the add-only photo library prompt", () => {
    const { expo } = readMobileAppConfig();
    for (const path of Object.values(expo.locales)) {
      const locale = JSON.parse(
        readFileSync(resolve(import.meta.dirname, "..", "..", path), "utf8"),
      ) as {
        ios?: Record<string, unknown>;
      };
      expect(typeof locale.ios?.NSPhotoLibraryAddUsageDescription).toBe("string");
      expect(locale.ios?.NSPhotoLibraryAddUsageDescription).not.toBe("");
    }
  });
});
