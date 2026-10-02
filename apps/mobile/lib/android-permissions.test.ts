import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type ConfigPlugin = string | [string, Record<string, unknown>];

type MobileAppConfig = {
  expo: {
    plugins: ConfigPlugin[];
  };
};

function readMobileAppConfig(): MobileAppConfig {
  const path = resolve(import.meta.dirname, "..", "app.json");
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
});
