import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UI_LOCALES } from "./ui-locale";

/** Agent import's own files; a string used only by these belongs to import. */
const IMPORT_FILES = [
  "src/lib/agent-import-errors.ts",
  "src/pages/shell/agent-import.tsx",
  "src/pages/shell/import-setup-card.tsx",
  "src/pages/shell/import-status.ts",
];
/** Import strings that live in shared files. */
const SHARED_IMPORT_STRINGS = ["Import an agent"];

const localesDir = new URL("../locales/", import.meta.url);
const catalog = (locale: string) =>
  readFileSync(fileURLToPath(new URL(`${locale}/messages.po`, localesDir)), "utf8")
    .split("\n\n")
    .filter((block) => !block.includes("#~"))
    .map((block) => {
      const strings = (key: "msgid" | "msgstr") => {
        const match = new RegExp(`^${key} ((?:".*"\\n?)+)`, "m").exec(block);
        return (match?.[1]?.match(/"(?:[^"\\]|\\.)*"/g) ?? [])
          .map((part) => JSON.parse(part) as string)
          .join("");
      };
      return {
        id: strings("msgid"),
        text: strings("msgstr"),
        // `#: src/a.tsx src/b.ts:12` lines: the files, with any line numbers removed.
        references: (block.match(/^#: .*$/gm) ?? [])
          .flatMap((line) => line.slice(3).split(" "))
          .map((reference) => reference.replace(/:\d+$/, "")),
      };
    })
    .filter((entry) => entry.id);

describe("agent import translations", () => {
  it("covers every catalog the app ships", () => {
    const shipped = readdirSync(fileURLToPath(localesDir)).sort();
    expect(shipped).toEqual([...UI_LOCALES].sort());
  });

  it("has every import string translated in every language", () => {
    const ids = catalog("en")
      .filter(
        (entry) =>
          (entry.references.length > 0 &&
            entry.references.every((file) => IMPORT_FILES.includes(file))) ||
          SHARED_IMPORT_STRINGS.includes(entry.id),
      )
      .map((entry) => entry.id);
    expect(ids.length).toBeGreaterThan(50);
    for (const locale of UI_LOCALES.filter((item) => item !== "en")) {
      const texts = new Map(catalog(locale).map((entry) => [entry.id, entry.text]));
      const blank = ids.filter((id) => !texts.get(id));
      expect(blank, locale).toEqual([]);
    }
  });
});
