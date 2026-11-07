import { describe, expect, it } from "vitest";
import { applyTranslations, findMismatches, listGaps, translationsOf } from "./catalog-gaps.ts";

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

#: src/d.ts
msgid "**Today**\\n"
"- {count} new"
msgstr "**Heute**\\n"
"- {count} neu"

#: src/e.ts
msgid "**Inbox**\\n"
"- {count} new"
msgstr ""
`;

describe("catalog gaps", () => {
  it("lists only empty entries, keyed by context and id", () => {
    expect(listGaps(po).map((gap) => gap.key)).toEqual([
      "{0, plural, one {# file} other {# files}}",
      "verb\u0004Run",
      "Open <0>{name}</0>",
      "**Inbox**\n- {count} new",
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
    expect(listGaps(filled)).toHaveLength(2);
    expect(applyTranslations(po, {}).po).toBe(po);
  });

  it("fills one catalog's gaps from another's translations", () => {
    const other = po
      .replace('msgid "Save"\nmsgstr "Speichern"', 'msgid "Save"\nmsgstr "Sichern"')
      .replace('msgid "Run"\nmsgstr ""', 'msgid "Run"\nmsgstr "Ausführen"');
    expect(translationsOf(other)).toMatchObject({ Save: "Sichern", "verb\u0004Run": "Ausführen" });
    const { po: merged } = applyTranslations(po, translationsOf(other));
    expect(merged).toContain('msgid "Save"\nmsgstr "Speichern"');
    expect(merged).toContain('msgid "Run"\nmsgstr "Ausführen"');
  });

  it("reads multi-line entries whole and fills them in place", () => {
    const { po: filled } = applyTranslations(po, {
      "**Inbox**\n- {count} new": "**Posteingang**\n- {count} neu",
    });
    expect(filled).toContain(
      'msgid "**Inbox**\\n"\n"- {count} new"\nmsgstr "**Posteingang**\\n- {count} neu"',
    );
    expect(filled).toContain('msgstr "**Heute**\\n"\n"- {count} neu"');
    expect(findMismatches(filled)).toEqual([]);
    expect(findMismatches(filled.replace('"- {count} neu"', '"- neu"'))).toHaveLength(1);
  });

  it("flags translations that drop or rename a placeholder or tag", () => {
    const { po: filled } = applyTranslations(po, {
      "{0, plural, one {# file} other {# files}}":
        "{count, plural, one {# Datei} other {# Dateien}}",
      "Open <0>{name}</0>": "{name} öffnen",
    });
    expect(findMismatches(filled)).toHaveLength(2);
    const { po: noCount } = applyTranslations(po, {
      "{0, plural, one {# file} other {# files}}": "{0, plural, one {eine Datei} other {Dateien}}",
    });
    expect(findMismatches(noCount)).toHaveLength(1);
    const { po: good } = applyTranslations(po, {
      "{0, plural, one {# file} other {# files}}": "{0, plural, one {# Datei} other {# Dateien}}",
    });
    expect(findMismatches(good)).toEqual([]);
  });
});
