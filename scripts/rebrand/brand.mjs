#!/usr/bin/env node
/**
 * Rebrand codemod for the Nurlai fork of Rakazo.
 *
 * Replaces the standalone display tokens only: `Rakazo` followed by a non-word
 * character. Code identifiers such as `RakazoDesktop` or `RAKAZO_*` env vars
 * are left untouched, so this pass cannot break imports or runtime config.
 *
 * Usage:
 *   node scripts/rebrand/brand.mjs --check
 *   node scripts/rebrand/brand.mjs --write
 *
 * LICENSE and NOTICE are excluded on purpose: Apache-2.0 requires both to be
 * preserved byte-for-byte.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { extname } from "node:path";

const ROOTS = [
  "apps/web",
  "apps/desktop",
  "apps/mobile",
  "packages/ui",
  "packages/ui-tokens",
  ".github",
  "README.md",
];

const EXCLUDED = new Set(["LICENSE", "NOTICE"]);

const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".html",
  ".css",
  ".md",
  ".po",
  ".pot",
  ".xml",
  ".swift",
  ".kt",
  ".kts",
  ".plist",
  ".strings",
  ".gradle",
  ".svg",
  ".yml",
  ".yaml",
  ".toml",
  ".py",
  ".sh",
]);

const DISPLAY_TOKEN = /Rakazo(?![A-Za-z0-9_])/g;
const MAX_BYTES = 5 * 1024 * 1024;

const write = process.argv.includes("--write");

const tracked = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

const files = tracked.filter((file) => {
  if (EXCLUDED.has(file)) return false;
  if (!ROOTS.some((root) => file === root || file.startsWith(`${root}/`))) return false;
  if (!EXTENSIONS.has(extname(file))) return false;
  try {
    return statSync(file).size <= MAX_BYTES;
  } catch {
    return false;
  }
});

let changedFiles = 0;
let changedOccurrences = 0;
const perFile = [];

for (const file of files) {
  const before = readFileSync(file, "utf8");
  if (before.includes("\0")) continue;

  const matches = before.match(new RegExp(DISPLAY_TOKEN.source, "g"));
  if (!matches) continue;

  changedFiles += 1;
  changedOccurrences += matches.length;
  perFile.push({ file, count: matches.length });

  if (write) {
    writeFileSync(file, before.replace(DISPLAY_TOKEN, "Nurlai"));
  }
}

perFile.sort((a, b) => b.count - a.count);

console.log(
  `${write ? "Rebranded" : "Would rebrand"} ${changedOccurrences} occurrences in ${changedFiles} files.`,
);
for (const { file, count } of perFile.slice(0, 15)) {
  console.log(`  ${String(count).padStart(4)}  ${file}`);
}
if (perFile.length > 15) console.log(`  ...and ${perFile.length - 15} more files`);

if (!write) {
  console.log("\nDry run only. Re-run with --write to apply.");
}
