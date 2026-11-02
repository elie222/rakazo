import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UI_LOCALES } from "./ui-locale";

const resources = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "modules/rakazo-notifications/android/src/main/res",
);
const keys = [
  "rakazo_channel_live",
  "rakazo_channel_messages",
  "rakazo_channel_scheduled",
  "rakazo_channel_attention",
  "rakazo_live_one",
  "rakazo_live_many",
  "rakazo_live_working",
  "rakazo_scheduled_title",
  "rakazo_replied_group",
  "rakazo_replied",
  "rakazo_attention_failed",
  "rakazo_attention_takeover",
  "rakazo_attention_input",
];

const resourceDirectories = {
  en: "values",
  "zh-CN": "values-zh-rCN",
  "zh-TW": "values-zh-rTW",
  ru: "values-ru",
  de: "values-de",
  nl: "values-nl",
  ja: "values-ja",
  es: "values-es",
} as const satisfies Record<(typeof UI_LOCALES)[number], string>;

function strings(locale: (typeof UI_LOCALES)[number]) {
  return readFileSync(resolve(resources, resourceDirectories[locale], "strings.xml"), "utf8");
}

describe("Android notification resources", () => {
  it("provides every notification string in each shipped mobile locale", () => {
    for (const locale of UI_LOCALES) {
      const xml = strings(locale);
      for (const key of keys) expect(xml).toContain(`name="${key}"`);
    }
  });

  it("keeps positional format arguments in translated strings", () => {
    expect(strings("de")).toContain("%1$s und %2$d");
    expect(strings("ru")).toContain("%1$s и ещё %2$d");
    expect(strings("zh-CN")).toContain("%1$s 和另外 %2$d");
    expect(strings("nl")).toContain("%1$s en %2$d anderen");
    expect(strings("ja")).toContain("%1$sとほか%2$d件");
    expect(strings("es")).toContain("%1$s y %2$d más");
  });
});
