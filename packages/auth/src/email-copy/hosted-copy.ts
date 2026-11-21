import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { translate } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { EmailCopyId } from "./defaults.js";
import { EMAIL_COPY_DEFAULTS, EMAIL_LOCALES } from "./defaults.js";
import type { CopyByLocale } from "./validate.js";
import { readCopyFile } from "./validate.js";

type Key<Id extends EmailCopyId> = keyof (typeof EMAIL_COPY_DEFAULTS)[Id] & string;
export type SayCopy<Id extends EmailCopyId> = (
  key: Key<Id>,
  values?: Record<string, string | number>,
) => string;

/**
 * Reads a deployment's email copy from `dir` (`<email>.json`, app language to key to text), once
 * per email. Each string falls back to the file's English, then to the default, and every
 * missing file or invalid string is logged once; sending never depends on the file. Without the
 * directory (an image built without copy) every email uses its default without a word.
 */
export function emailCopyReader(
  dir: string | undefined,
  warn: (problem: string) => void = (problem) =>
    getLogger().warn("email copy falls back to the default", { "email_copy.problem": problem }),
) {
  const loaded = new Map<EmailCopyId, CopyByLocale>();
  const present = Boolean(dir && existsSync(dir));
  const load = (id: EmailCopyId): CopyByLocale => {
    const cached = loaded.get(id);
    if (cached) return cached;
    let copy: CopyByLocale = {};
    if (dir && present) {
      try {
        const read = readCopyFile(
          EMAIL_COPY_DEFAULTS,
          EMAIL_LOCALES,
          id,
          JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")),
        );
        copy = read.copy;
        for (const problem of read.problems) warn(problem);
      } catch (error) {
        warn(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    loaded.set(id, copy);
    return copy;
  };
  return <Id extends EmailCopyId>(id: Id, locale: string): SayCopy<Id> =>
    (key, values) => {
      const copy = load(id);
      const fallback = (EMAIL_COPY_DEFAULTS[id] as Readonly<Record<string, string>>)[key] ?? key;
      return translate(undefined, copy[locale]?.[key] ?? copy.en?.[key] ?? fallback, values);
    };
}

let deploymentCopy: ReturnType<typeof emailCopyReader> | undefined;

/** The copy of one email in `locale`: the deployment's (`EMAIL_COPY_DIR`), else the default. */
export function emailCopy<Id extends EmailCopyId>(id: Id, locale: string): SayCopy<Id> {
  deploymentCopy ??= emailCopyReader(process.env.EMAIL_COPY_DIR || undefined);
  return deploymentCopy(id, locale);
}
