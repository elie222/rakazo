import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UI_LOCALES } from "./ui-locale";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = resolve(mobileRoot, "modules/rakazo-notifications/android/src/main");

function source(path: string) {
  return readFileSync(resolve(nativeRoot, path), "utf8");
}

describe("Android call foreground service", () => {
  it("declares a microphone foreground service and wake lock", () => {
    const manifest = source("AndroidManifest.xml");
    expect(manifest).toContain("android.permission.FOREGROUND_SERVICE_MICROPHONE");
    expect(manifest).toContain("android.permission.WAKE_LOCK");
    expect(manifest).toContain('android:name=".RakazoCallService"');
    expect(manifest).toContain('android:foregroundServiceType="microphone"');
  });

  it("starts immediately as a foreground service and holds a partial wake lock", () => {
    const service = source("java/com/rakazo/notifications/RakazoCallService.kt");
    expect(service).toContain("startForeground");
    expect(service).toContain("FOREGROUND_SERVICE_TYPE_MICROPHONE");
    expect(service).toContain("PowerManager.PARTIAL_WAKE_LOCK");
    expect(service).toContain("context.startForegroundService(intent)");
    expect(service).toContain("context.stopService");
    expect(service).toContain("Manifest.permission.RECORD_AUDIO");
    expect(service).toContain("try {");
    expect(service).toMatch(/catch \(_: Exception\)/);
  });

  it("provides call strings in every shipped mobile locale", () => {
    const directories = {
      en: "values",
      "zh-CN": "values-zh-rCN",
      "zh-TW": "values-zh-rTW",
      ru: "values-ru",
      de: "values-de",
      nl: "values-nl",
      ja: "values-ja",
    } as const satisfies Record<(typeof UI_LOCALES)[number], string>;
    const keys = ["rakazo_call_channel", "rakazo_call_title", "rakazo_call_text"];
    for (const locale of UI_LOCALES) {
      const xml = source(`res/${directories[locale]}/call_strings.xml`);
      for (const key of keys) expect(xml).toContain(`name="${key}"`);
    }
  });

  // call-card-keep-awake.test.tsx covers the call card starting the service instead of keep-awake.
  it("is exposed to the JS bridge", () => {
    const module = source("java/com/rakazo/notifications/RakazoNotificationsModule.kt");
    expect(module).toContain('AsyncFunction("startCall")');
    expect(module).toContain('AsyncFunction("stopCall")');
  });
});
