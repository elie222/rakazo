import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmailCopyId } from "./email-keys.js";
import { EMAIL_COPY_KEYS } from "./email-keys.js";

/** Fake English strings for one email: `Test <key> {placeholder}...`, so tests can find them. */
export function fakeEmailStrings(id: EmailCopyId, label = "Test"): Record<string, string> {
  return Object.fromEntries(
    Object.entries(EMAIL_COPY_KEYS[id]).map(([key, names]) => [
      key,
      [`${label} ${key}`, ...(names as readonly string[]).map((name) => `{${name}}`)].join(" "),
    ]),
  );
}

/**
 * Writes a copy folder for tests and returns its path. Each email maps to its file's contents;
 * `true` writes fake English for it, and an email left out gets no file.
 */
export function writeEmailCopyDir(
  emails: Partial<Record<EmailCopyId, true | string | object>>,
): string {
  const dir = mkdtempSync(join(tmpdir(), "email-copy-"));
  for (const [id, file] of Object.entries(emails)) {
    const contents = file === true ? { en: fakeEmailStrings(id as EmailCopyId) } : file;
    writeFileSync(
      join(dir, `${id}.json`),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }
  return dir;
}
