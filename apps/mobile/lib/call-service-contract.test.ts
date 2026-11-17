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

  it("uses the saved app locale for the incoming-call notification and call screen", () => {
    const calls = source("java/com/rakazo/notifications/IncomingCalls.kt");
    expect(calls).toContain(
      "val copy = localizedContext(context, NotificationStorage(context).locale)",
    );
    for (const key of ["rakazo_call_title", "rakazo_call_decline", "rakazo_call_answer"]) {
      expect(calls).not.toMatch(new RegExp(`context\\.getString\\(R\\.string\\.${key}`));
    }
    expect(calls).toContain(
      "super.attachBaseContext(localizedContext(base, NotificationStorage(base).locale))",
    );
  });

  it("uses the saved app locale for call notification strings and keeps a supplied title", () => {
    const service = source("java/com/rakazo/notifications/RakazoCallService.kt");
    expect(service).toContain(
      "val copyContext = localizedContext(this, NotificationStorage(this).locale)",
    );
    expect(service).toMatch(
      /getStringExtra\(EXTRA_TITLE\)\?\.takeIf\(String::isNotBlank\) \?: copyContext\.getString\(/,
    );
    expect(service).toContain("createChannel(copyContext)");
    expect(service).toContain("startForegroundCompat(copyContext, title)");
    expect(service).toContain("private fun createChannel(copyContext: Context)");
    expect(service).toContain(
      "private fun startForegroundCompat(copyContext: Context, title: String)",
    );
    for (const key of ["rakazo_call_title", "rakazo_call_text", "rakazo_call_channel"]) {
      expect(service).toMatch(new RegExp(`copyContext\\.getString\\(\\s*R\\.string\\.${key}`));
    }
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
      es: "values-es",
      pl: "values-pl",
      fr: "values-fr",
      he: "values-iw",
      hi: "values-hi",
      ko: "values-ko",
      "pt-BR": "values-pt-rBR",
      tr: "values-tr",
    } as const satisfies Record<(typeof UI_LOCALES)[number], string>;
    const keys = [
      "rakazo_call_channel",
      "rakazo_call_title",
      "rakazo_call_text",
      "rakazo_call_answer",
      "rakazo_call_decline",
    ];
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
