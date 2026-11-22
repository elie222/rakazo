import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOGS } from "../email.js";
import type { EmailCopyReport } from "./deployment-copy.js";
import { emailCopyReader } from "./deployment-copy.js";
import { fakeEmailStrings, writeEmailCopyDir } from "./email-copy.test-support.js";
import { EMAIL_COPY_KEYS, EMAIL_LOCALES } from "./email-keys.js";
import { readCopyFile } from "./validate.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyDir(...args: Parameters<typeof writeEmailCopyDir>): string {
  const dir = writeEmailCopyDir(...args);
  dirs.push(dir);
  return dir;
}

/** A complete copy file: every language with the given strings. */
function everyLanguage(strings: Record<string, string>) {
  return Object.fromEntries(EMAIL_LOCALES.map((locale) => [locale, strings]));
}

function reader(dir: string | undefined) {
  const reports: EmailCopyReport[] = [];
  return { reports, copy: emailCopyReader(dir, (report) => reports.push(report)) };
}

const referral = fakeEmailStrings("referral");

describe("deployment email copy", () => {
  it.each([undefined, join(tmpdir(), "email-copy-absent")])(
    "turns an email off, and says so once, without copy at %s",
    (dir) => {
      const { copy, reports } = reader(dir);
      expect(copy.available("referral")).toBe(false);
      expect(copy.available("referral")).toBe(false);
      expect(() => copy.copy("referral", "en")("subject")).toThrow("no copy");
      expect(reports).toEqual([
        { email: "referral", off: "missing", problems: [expect.any(String)] },
      ]);
    },
  );

  it("sends an email whose English is complete, in its language, else that English", () => {
    const { copy, reports } = reader(
      copyDir({
        referral: { ...everyLanguage(referral), de: fakeEmailStrings("referral", "Test de") },
      }),
    );
    expect(copy.available("referral")).toBe(true);
    expect(copy.available("welcome")).toBe(false);
    expect(copy.copy("referral", "de")("body", { weeks: 3 })).toBe("Test de body 3");
    expect(copy.copy("referral", "fr")("body", { weeks: 3 })).toBe("Test body 3");
    expect(reports).toEqual([
      { email: "referral", problems: [] },
      { email: "welcome", off: "missing", problems: [expect.any(String)] },
    ]);
  });

  it("falls back to the file's English string by string and names each problem", () => {
    const { copy, reports } = reader(
      copyDir({
        referral: { en: referral, de: { ...referral, subject: 3, body: "Test no weeks" } },
      }),
    );
    const de = copy.copy("referral", "de");
    expect(de("subject")).toBe("Test subject");
    expect(de("body", { weeks: 2 })).toBe("Test body 2");
    expect(de("link")).toBe("Test link");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.off).toBeUndefined();
    expect(reports[0]?.problems).toEqual(
      expect.arrayContaining([
        "referral.fr: missing",
        "referral.de.subject: not a non-empty string",
        "referral.de.body: placeholders none, expected weeks",
      ]),
    );
  });

  it.each([
    ["an English string is missing", { en: { ...referral, link: undefined } }],
    ["an English string has the wrong placeholders", { en: { ...referral, body: "Test" } }],
    ["the file has no English", { de: referral }],
    ["the file is not JSON", "{not json"],
  ])("turns an email off when %s", (_case, file) => {
    const { copy, reports } = reader(copyDir({ referral: file }));
    expect(copy.available("referral")).toBe(false);
    expect(reports).toEqual([
      { email: "referral", off: "invalid", problems: expect.arrayContaining([expect.any(String)]) },
    ]);
  });

  it("lists copy this release does not use without failing", () => {
    const file = { ...everyLanguage(referral), "pt-br": referral };
    const read = readCopyFile(EMAIL_COPY_KEYS, EMAIL_LOCALES, "referral", file);
    expect(read.problems).toEqual([]);
    expect(read.complete).toBe(true);
    expect(read.unused).toEqual(["referral.pt-br: no such language"]);
    expect(readCopyFile(EMAIL_COPY_KEYS, EMAIL_LOCALES, "later", {}).unused).toEqual([
      "later: no such email",
    ]);
  });

  it("lists every language an email can be written in", () => {
    expect([...EMAIL_LOCALES].sort()).toEqual(["en", ...Object.keys(CATALOGS)].sort());
  });

  it("accepts fake strings for every key of every email as a complete file", () => {
    for (const id of Object.keys(EMAIL_COPY_KEYS) as (keyof typeof EMAIL_COPY_KEYS)[]) {
      const read = readCopyFile(
        EMAIL_COPY_KEYS,
        EMAIL_LOCALES,
        id,
        everyLanguage(fakeEmailStrings(id)),
      );
      expect(read.problems).toEqual([]);
      expect(read.complete).toBe(true);
    }
  });
});
