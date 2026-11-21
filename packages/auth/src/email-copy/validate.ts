// No runtime imports: scripts/check-email-copy.ts runs this file under plain Node.
import type { EmailCopyId } from "./defaults.js";

type Defaults = Readonly<Record<string, Readonly<Record<string, string>>>>;
/** One email's usable copy: app language to key to text. */
export type CopyByLocale = Record<string, Record<string, string>>;

export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();
}

/**
 * Keeps each string of a copy file that the email can use: a non-empty string with the same
 * placeholders as its default. A string that would fall back (invalid, or a language or key the
 * file lacks) is named in `problems`. An email, language or key this release does not know is
 * named in `unused`: newer copy may add one before an older release is rebuilt.
 */
export function readCopyFile(
  defaults: Defaults,
  locales: readonly string[],
  id: EmailCopyId | string,
  file: unknown,
): { copy: CopyByLocale; problems: string[]; unused: string[] } {
  const keys = defaults[id];
  const copy: CopyByLocale = {};
  const problems: string[] = [];
  const unused: string[] = [];
  if (!keys) return { copy, problems, unused: [`${id}: no such email`] };
  if (!isRecord(file)) return { copy, problems: [`${id}: not an object of languages`], unused };
  for (const locale of locales)
    if (!Object.hasOwn(file, locale)) problems.push(`${id}.${locale}: missing`);
  for (const [locale, strings] of Object.entries(file)) {
    if (!locales.includes(locale)) {
      unused.push(`${id}.${locale}: no such language`);
      continue;
    }
    if (!isRecord(strings)) {
      problems.push(`${id}.${locale}: not an object of strings`);
      continue;
    }
    const kept: Record<string, string> = {};
    for (const [key, text] of Object.entries(strings)) {
      const fallback = Object.hasOwn(keys, key) ? keys[key] : undefined;
      if (fallback === undefined) unused.push(`${id}.${locale}.${key}: no such key`);
      else if (typeof text !== "string" || !text.trim())
        problems.push(`${id}.${locale}.${key}: not a non-empty string`);
      else if (placeholders(text).join() !== placeholders(fallback).join())
        problems.push(
          `${id}.${locale}.${key}: placeholders ${placeholders(text).join() || "none"}, expected ${placeholders(fallback).join() || "none"}`,
        );
      else kept[key] = text;
    }
    for (const key of Object.keys(keys))
      if (!Object.hasOwn(strings, key)) problems.push(`${id}.${locale}.${key}: missing`);
    copy[locale] = kept;
  }
  return { copy, problems, unused };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
