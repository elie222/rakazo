import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatter } from "@lingui/format-po";
import { expect, it } from "vitest";
import { UI_LOCALES } from "../../lib/locale/ui-locale";

it("keeps every account catalog complete with matching source placeholders", async () => {
  const read = (locale: string) => {
    const filename = fileURLToPath(new URL(`./locales/${locale}/messages.po`, import.meta.url));
    return formatter().parse(readFileSync(filename, "utf8"), {
      locale,
      sourceLocale: "en",
      filename,
    });
  };
  const source = await read("en");
  for (const id of [
    "Model account",
    "API protocol",
    "Refresh models",
    "Agree and authorize",
    "Authorize access to {serviceName} models",
  ])
    expect(
      Object.values(source).some((entry) => entry.message === id || entry.translation === id),
    ).toBe(true);
  for (const locale of UI_LOCALES) {
    const messages = await read(locale);
    expect(Object.keys(messages).sort()).toEqual(Object.keys(source).sort());
    for (const [id, entry] of Object.entries(messages)) {
      if (!entry.translation?.trim()) continue;
      const markers = (value: string) =>
        [...value.matchAll(/\{[A-Za-z0-9_]+\}|<\/?[0-9]+\s*\/?>/g)].map((match) => match[0]).sort();
      expect(markers(entry.translation)).toEqual(markers(source[id]!.message ?? id));
    }
  }
});
