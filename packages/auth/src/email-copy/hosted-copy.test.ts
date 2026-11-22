import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOGS } from "../email.js";
import { EMAIL_COPY_DEFAULTS, EMAIL_LOCALES } from "./defaults.js";
import { emailCopyReader } from "./hosted-copy.js";
import { placeholders, readCopyFile } from "./validate.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "email-copy-"));
  dirs.push(dir);
  for (const [id, file] of Object.entries(files))
    writeFileSync(join(dir, `${id}.json`), typeof file === "string" ? file : JSON.stringify(file));
  return dir;
}

/** A complete copy file: every language with the given strings. */
function everyLanguage(strings: Record<string, string>) {
  return Object.fromEntries(EMAIL_LOCALES.map((locale) => [locale, strings]));
}

function reader(dir: string | undefined) {
  const problems: string[] = [];
  return { problems, copy: emailCopyReader(dir, (problem) => problems.push(problem)) };
}

const referral = EMAIL_COPY_DEFAULTS.referral;

describe("email copy", () => {
  it.each([undefined, join(tmpdir(), "email-copy-absent")])(
    "uses the defaults, without a word, when the deployment has no copy at %s",
    (dir) => {
      const { copy, problems } = reader(dir);
      expect(copy("referral", "de")("body", { weeks: 2 })).toBe(
        referral.body.replace("{weeks}", "2"),
      );
      expect(problems).toEqual([]);
    },
  );

  it("lists copy this release does not use without falling back", () => {
    const file = { ...everyLanguage(referral), "pt-br": referral };
    const read = readCopyFile(EMAIL_COPY_DEFAULTS, EMAIL_LOCALES, "referral", file);
    expect(read.problems).toEqual([]);
    expect(read.unused).toEqual(["referral.pt-br: no such language"]);
    expect(readCopyFile(EMAIL_COPY_DEFAULTS, EMAIL_LOCALES, "later", {}).unused).toEqual([
      "later: no such email",
    ]);
  });

  it("uses the deployment's copy in the email's language, else its English", () => {
    const { copy, problems } = reader(
      copyDir({
        referral: {
          ...everyLanguage({ ...referral, subject: "Hosted subject", body: "Hosted {weeks}" }),
          de: { ...referral, subject: "Gehostet", body: "Gehostet {weeks}" },
        },
      }),
    );
    expect(copy("referral", "de")("subject")).toBe("Gehostet");
    expect(copy("referral", "de")("body", { weeks: 3 })).toBe("Gehostet 3");
    expect(copy("referral", "fr")("body", { weeks: 3 })).toBe("Hosted 3");
    expect(problems).toEqual([]);
  });

  it("names a missing language, ignores an unknown one, and writes in the file's English", () => {
    const { en, ...rest } = everyLanguage({ ...referral, subject: "Hosted subject" });
    const { fr: _fr, ...withoutFrench } = rest;
    const { copy, problems } = reader(copyDir({ referral: { en, ...withoutFrench, "pt-br": en } }));
    expect(copy("referral", "fr")("subject")).toBe("Hosted subject");
    expect(problems).toEqual(["referral.fr: missing"]);
  });

  it("falls back string by string and names each problem once", () => {
    const { copy, problems } = reader(
      copyDir({
        referral: {
          en: { subject: "Hosted subject", body: "No weeks here", extra: "x" },
          de: { subject: 3 },
        },
      }),
    );
    const de = copy("referral", "de");
    expect(de("subject")).toBe("Hosted subject");
    expect(de("body", { weeks: 2 })).toBe(referral.body.replace("{weeks}", "2"));
    expect(de("link")).toBe(referral.link);
    de("body");
    expect(problems).toEqual(
      expect.arrayContaining([
        "referral.en.body: placeholders none, expected weeks",
        "referral.en.link: missing",
        "referral.de.subject: not a non-empty string",
      ]),
    );
    expect(new Set(problems).size).toBe(problems.length);
  });

  it("keeps sending on the defaults when a file is missing or unreadable", () => {
    const { copy, problems } = reader(copyDir({ welcome: "{not json" }));
    expect(copy("welcome", "en")("subject")).toBe(EMAIL_COPY_DEFAULTS.welcome.subject);
    expect(copy("referral", "en")("subject")).toBe(referral.subject);
    copy("referral", "en")("link");
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^welcome: /);
    expect(problems[1]).toMatch(/^referral: .*ENOENT/);
  });

  it("lists every language an email can be written in", () => {
    expect([...EMAIL_LOCALES].sort()).toEqual(["en", ...Object.keys(CATALOGS)].sort());
  });

  it("accepts its own defaults as a complete copy file", () => {
    for (const [id, strings] of Object.entries(EMAIL_COPY_DEFAULTS)) {
      expect(
        readCopyFile(EMAIL_COPY_DEFAULTS, EMAIL_LOCALES, id, everyLanguage(strings)).problems,
      ).toEqual([]);
      for (const text of Object.values(strings))
        expect(placeholders(text).every((name) => /^\w+$/.test(name))).toBe(true);
    }
  });
});
