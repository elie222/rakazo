// Prints every package the mobile app resolves from a pnpm v9 lockfile on stdin, one per line,
// with versions, peer suffixes and patch hashes, so any change a native build could see differs.
// Line-based on purpose: CI runs it before dependencies are installed.
import { readFileSync } from "node:fs";
import { posix } from "node:path";

const ROOT = "apps/mobile";
const unquote = (value) => value.trim().replace(/^'(.*)'$/, "$1");
const indent = (line) => line.length - line.trimStart().length;

const importers = new Map();
const snapshots = new Map();
let section = "";
let owner = null;
let group = "";
let depName = null;
for (const line of readFileSync(0, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const depth = indent(line);
  if (depth === 0) {
    section = line.replace(/:.*$/, "");
    continue;
  }
  const text = line.trim();
  if (section === "importers") {
    if (depth === 2) {
      owner = [];
      importers.set(unquote(text.replace(/:$/, "")), owner);
    } else if (depth === 4) {
      group = text.replace(/:$/, "");
    } else if (depth === 6) {
      depName = unquote(text.replace(/:$/, ""));
    } else if (depth === 8 && text.startsWith("version:") && group.endsWith("ependencies")) {
      owner.push([depName, text.slice("version:".length).trim()]);
    }
  } else if (section === "snapshots") {
    if (depth === 2) {
      owner = [];
      snapshots.set(unquote(text.replace(/:( \{\})?$/, "")), owner);
    } else if (depth === 4) {
      group = text.replace(/:$/, "");
    } else if (depth === 6 && group !== "transitivePeerDependencies") {
      const split = text.indexOf(": ");
      owner.push([unquote(text.slice(0, split)), unquote(text.slice(split + 2))]);
    }
  }
}

const seen = new Set();
const visit = (from, [name, version]) => {
  if (version.startsWith("link:")) {
    const importer = posix.join(from, version.slice("link:".length));
    if (!seen.has(importer) && importers.has(importer)) {
      seen.add(importer);
      for (const dep of importers.get(importer)) visit(importer, dep);
    }
    return;
  }
  const key = version.startsWith("npm:") ? version.slice(4) : `${name}@${version}`;
  if (seen.has(key)) return;
  seen.add(key);
  for (const dep of snapshots.get(key) ?? []) visit(from, dep);
};

if (!importers.has(ROOT)) throw new Error(`${ROOT} is missing from the lockfile`);
seen.add(ROOT);
for (const dep of importers.get(ROOT)) visit(ROOT, dep);
console.log([...seen].sort().join("\n"));
