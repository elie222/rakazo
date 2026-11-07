#!/usr/bin/env node
// Lists, fills and checks untranslated entries in the web Lingui catalogs.
//
//   node catalog-gaps.ts list <locale>          JSON array of untranslated entries
//   node catalog-gaps.ts apply <locale> <json>  fill empty entries from {key: translation}
//   node catalog-gaps.ts check [locale...]      count gaps and placeholder mismatches
//
// A key is the msgid, or `msgctxt\u0004msgid` when the entry has a context. `apply` only
// writes entries that are still empty, so it never overwrites a translation.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCALES_DIR = "apps/web/src/locales";
const SOURCE_LOCALE = "en";

export type Gap = { key: string; msgctxt: string | null; msgid: string; notes: string[] };

type Entry = Gap & { msgstr: string; msgstrAt: [number, number] };

function parseEntry(block: string): Entry | null {
  const context = /^msgctxt (".*")$/m.exec(block);
  const id = /^msgid (".*")$/m.exec(block);
  const str = /^msgstr (".*")$/m.exec(block);
  if (!id || !str) return null;
  const msgid = JSON.parse(id[1]) as string;
  if (msgid === "") return null;
  const msgctxt = context ? (JSON.parse(context[1]) as string) : null;
  return {
    key: msgctxt ? `${msgctxt}\u0004${msgid}` : msgid,
    msgctxt,
    msgid,
    notes: block.split("\n").filter((line) => line.startsWith("#.") || line.startsWith("#:")),
    msgstr: JSON.parse(str[1]) as string,
    msgstrAt: [str.index, str.index + str[0].length],
  };
}

export function listGaps(po: string): Gap[] {
  return po
    .split("\n\n")
    .map(parseEntry)
    .filter((entry): entry is Entry => entry !== null && entry.msgstr === "")
    .map(({ key, msgctxt, msgid, notes }) => ({ key, msgctxt, msgid, notes }));
}

export function applyTranslations(po: string, translations: Record<string, unknown>) {
  let filled = 0;
  const blocks = po.split("\n\n").map((block) => {
    const entry = parseEntry(block);
    if (entry?.msgstr !== "") return block;
    const value = translations[entry.key];
    if (typeof value !== "string" || !value.trim()) return block;
    filled++;
    const [start, end] = entry.msgstrAt;
    return `${block.slice(0, start)}msgstr ${JSON.stringify(value)}${block.slice(end)}`;
  });
  return { po: blocks.join("\n\n"), filled };
}

function tokens(text: string) {
  const names = new Set([
    ...[...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
    ...[...text.matchAll(/\{(\w+),\s*(?:plural|select|selectordinal)\b/g)].map((m) => m[1]),
  ]);
  const tags = [...text.matchAll(/<\/?\d+\/?>/g)].map((m) => m[0]);
  return JSON.stringify([[...names].sort(), tags.sort()]);
}

// Returns one line per translation that drops or adds a placeholder or tag.
export function findMismatches(po: string): string[] {
  return po
    .split("\n\n")
    .map(parseEntry)
    .filter((entry): entry is Entry => entry !== null && entry.msgstr !== "")
    .filter(
      ({ msgid, msgstr }) =>
        tokens(msgid) !== tokens(msgstr) || msgstr.split("{").length !== msgstr.split("}").length,
    )
    .map(({ key, msgstr }) => `${JSON.stringify(key)} -> ${JSON.stringify(msgstr)}`);
}

const catalogPath = (locale: string) => join(LOCALES_DIR, locale, "messages.po");
const targetLocales = () =>
  readdirSync(LOCALES_DIR)
    .filter((locale) => locale !== SOURCE_LOCALE)
    .sort();

function main([command, ...args]: string[]) {
  if (command === "list" && args.length === 1) {
    console.log(JSON.stringify(listGaps(readFileSync(catalogPath(args[0]), "utf8")), null, 1));
    return 0;
  }
  if (command === "apply" && args.length === 2) {
    const path = catalogPath(args[0]);
    const translations = JSON.parse(readFileSync(args[1], "utf8")) as Record<string, unknown>;
    const result = applyTranslations(readFileSync(path, "utf8"), translations);
    writeFileSync(path, result.po);
    console.log(`${args[0]}: filled ${result.filled}`);
    return 0;
  }
  if (command === "check") {
    let failed = false;
    for (const locale of args.length ? args : targetLocales()) {
      const po = readFileSync(catalogPath(locale), "utf8");
      const gaps = listGaps(po).length;
      const mismatches = findMismatches(po);
      console.log(`${locale}: ${gaps} untranslated, ${mismatches.length} placeholder mismatches`);
      for (const line of mismatches) console.log(`  ${line}`);
      failed ||= gaps > 0 || mismatches.length > 0;
    }
    return failed ? 1 : 0;
  }
  console.error("usage: catalog-gaps.ts list <locale> | apply <locale> <json> | check [locale...]");
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
