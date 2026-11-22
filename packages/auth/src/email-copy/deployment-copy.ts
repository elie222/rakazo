import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { translate } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { EmailCopyId } from "./email-keys.js";
import { EMAIL_COPY_KEYS, EMAIL_LOCALES } from "./email-keys.js";
import type { CopyByLocale } from "./validate.js";
import { readCopyFile } from "./validate.js";

type Key<Id extends EmailCopyId> = keyof (typeof EMAIL_COPY_KEYS)[Id] & string;
export type SayCopy<Id extends EmailCopyId> = (
  key: Key<Id>,
  values?: Record<string, string | number>,
) => string;

/** What reading one email's copy found; `off` names why the email is not sent. */
export type EmailCopyReport =
  | { email: EmailCopyId; off: "missing" | "invalid"; problems: string[] }
  | { email: EmailCopyId; off?: undefined; problems: string[] };

function logReport({ email, off, problems }: EmailCopyReport): void {
  const attributes = { "email.kind": email, "email_copy.problems": problems.join("; ") };
  if (off === "missing")
    getLogger().info("email is off: the deployment supplies no copy for it", attributes);
  else if (off === "invalid")
    getLogger().warn("email is off: its copy has no valid English for every key", attributes);
  else if (problems.length > 0)
    getLogger().warn("email copy falls back to the file's English", attributes);
}

/**
 * Reads a deployment's email copy from `dir` (`<email>.json`, app language to key to text), once
 * per email, and reports each email once. An email is sent only when its file's English holds a
 * valid string for every key; another language's missing or invalid string falls back to that
 * English.
 */
export function emailCopyReader(
  dir: string | undefined,
  report: (report: EmailCopyReport) => void = logReport,
) {
  const loaded = new Map<EmailCopyId, CopyByLocale | null>();
  const load = (id: EmailCopyId): CopyByLocale | null => {
    const cached = loaded.get(id);
    if (cached !== undefined) return cached;
    const file = dir ? join(dir, `${id}.json`) : undefined;
    let copy: CopyByLocale | null = null;
    if (!file || !existsSync(file))
      report({ email: id, off: "missing", problems: [file ? `no ${file}` : "no EMAIL_COPY_DIR"] });
    else {
      try {
        const read = readCopyFile(
          EMAIL_COPY_KEYS,
          EMAIL_LOCALES,
          id,
          JSON.parse(readFileSync(file, "utf8")),
        );
        if (read.complete) copy = read.copy;
        report(
          read.complete
            ? { email: id, problems: read.problems }
            : { email: id, off: "invalid", problems: read.problems },
        );
      } catch (error) {
        report({
          email: id,
          off: "invalid",
          problems: [`${id}: ${error instanceof Error ? error.message : String(error)}`],
        });
      }
    }
    loaded.set(id, copy);
    return copy;
  };
  return {
    available: (id: EmailCopyId): boolean => load(id) !== null,
    copy:
      <Id extends EmailCopyId>(id: Id, locale: string): SayCopy<Id> =>
      (key, values) => {
        const copy = load(id);
        const text = copy?.[locale]?.[key] ?? copy?.en?.[key];
        if (text === undefined) throw new Error(`The ${id} email has no copy`);
        return translate(undefined, text, values);
      },
  };
}

const readers = new Map<string, ReturnType<typeof emailCopyReader>>();

function deploymentCopy() {
  const dir = process.env.EMAIL_COPY_DIR?.trim() ?? "";
  let reader = readers.get(dir);
  if (!reader) {
    reader = emailCopyReader(dir || undefined);
    readers.set(dir, reader);
  }
  return reader;
}

/** Whether the deployment's copy (`EMAIL_COPY_DIR`) lets this email be sent; reported once. */
export function emailCopyAvailable(id: EmailCopyId): boolean {
  return deploymentCopy().available(id);
}

/** The deployment's copy of one email in `locale`; only for an email that is available. */
export function emailCopy<Id extends EmailCopyId>(id: Id, locale: string): SayCopy<Id> {
  return deploymentCopy().copy(id, locale);
}
