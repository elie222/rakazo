#!/usr/bin/env node
/**
 * Rebuilds the default-file table in packages/core/src/agent-import/stock.ts.
 *
 *   node scripts/agent-import-defaults.mjs <openclaw-checkout> [<hermes-SOUL.md> ...]
 *
 * Reads every committed version of OpenClaw's docs/reference/templates/{SOUL,AGENTS,USER,
 * IDENTITY}.md from a local git checkout, and each given Hermes SOUL.md, and prints the
 * table with the commits each fingerprint covers. Offline: it only reads local files and git.
 * The fingerprint matches `fingerprint()` in stock.ts: front matter removed (OpenClaw only,
 * as OpenClaw seeds the file), a byte order mark dropped, whitespace runs collapsed, then
 * `<32-bit FNV-1a hex>:<UTF-8 length>`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [checkout, ...hermes] = process.argv.slice(2);
if (!checkout) {
  console.error("usage: agent-import-defaults.mjs <openclaw-checkout> [<hermes-SOUL.md> ...]");
  process.exit(1);
}

function fingerprint(content) {
  const text = content
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, " ")
    .trim();
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}:${bytes.length}`;
}

function withoutFrontmatter(content) {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return text.replace(/^---\n[\s\S]*?\n---\n/, "");
}

const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" });

for (const name of ["SOUL", "AGENTS", "USER", "IDENTITY"]) {
  const file = `docs/reference/templates/${name}.md`;
  // Each commit that touched the file, with the path it had then (renames followed).
  const log = git("log", "--follow", "--format=%h", "--name-only", "--", file)
    .split("\n")
    .filter(Boolean);
  const versions = new Map();
  for (let index = 0; index < log.length; index += 2) {
    const [sha, path] = [log[index], log[index + 1]];
    let content;
    try {
      content = git("show", `${sha}:${path}`);
    } catch {
      continue;
    }
    if (!content.trim()) continue;
    const key = fingerprint(withoutFrontmatter(content));
    versions.set(key, [...(versions.get(key) ?? []), sha]);
  }
  console.log(`  "${name}.md": versions([`);
  for (const [key, shas] of versions) console.log(`    "${key}", // ${shas.join(" ")}`);
  console.log("  ]),");
}
for (const path of hermes) {
  console.log(
    `"${fingerprint(readFileSync(path, "utf8"))}", // Hermes SOUL.md: ${path.split("/").at(-1)}`,
  );
}
