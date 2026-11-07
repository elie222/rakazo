import { describe, expect, it } from "vitest";
import { applyTranslations, findMismatches, listGaps } from "./catalog-gaps.ts";

const po = `msgid ""
msgstr ""
"Language: de\\n"

#: src/a.tsx
msgid "Save"
msgstr "Speichern"

#. placeholder {0}: files.length
#: src/b.tsx
msgid "{0, plural, one {# file} other {# files}}"
msgstr ""

msgctxt "verb"
msgid "Run"
msgstr ""

#: src/c.tsx
msgid "Open <0>{name}</0>"
msgstr ""
`;

describe("catalog gaps", () => {
  it("lists only empty entries, keyed by context and id", () => {
    expect(listGaps(po).map((gap) => gap.key)).toEqual([
      "{0, plural, one {# file} other {# files}}",
      "verb\u0004Run",
      "Open <0>{name}</0>",
    ]);
    expect(listGaps(po)[0]?.notes).toEqual(["#. placeholder {0}: files.length", "#: src/b.tsx"]);
  });

  it("fills empty entries and never overwrites a translation", () => {
    const { po: filled, filled: count } = applyTranslations(po, {
      Save: "Sichern",
      "verb\u0004Run": "Ausführen",
      "Open <0>{name}</0>": "<0>{name}</0> öffnen",
      Unknown: "x",
    });
    expect(count).toBe(2);
    expect(filled).toContain('msgid "Save"\nmsgstr "Speichern"');
    expect(filled).toContain('msgctxt "verb"\nmsgid "Run"\nmsgstr "Ausführen"');
    expect(filled).toContain('msgstr "<0>{name}</0> öffnen"');
    expect(listGaps(filled)).toHaveLength(1);
    expect(applyTranslations(po, {}).po).toBe(po);
  });

  it("flags translations that drop or rename a placeholder or tag", () => {
    const { po: filled } = applyTranslations(po, {
      "{0, plural, one {# file} other {# files}}":
        "{count, plural, one {# Datei} other {# Dateien}}",
      "Open <0>{name}</0>": "{name} öffnen",
    });
    expect(findMismatches(filled)).toHaveLength(2);
    const { po: good } = applyTranslations(po, {
      "{0, plural, one {# file} other {# files}}": "{0, plural, one {# Datei} other {# Dateien}}",
    });
    expect(findMismatches(good)).toEqual([]);
  });
});
