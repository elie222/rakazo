// Ratchets: each rule in ratchets/ freezes today's violations per file in its baseline, so new
// code obeys the rule at once and old code is cleaned up later. See README.md.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const rulesDir = path.join(here, "ratchets");

/** Loads every rule module in `dir`; a rule is named after its file. */
export async function loadRules(dir = rulesDir) {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".mjs"))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const rule = await import(pathToFileURL(path.join(dir, file)).href);
      const name = file.slice(0, -".mjs".length);
      if (typeof rule.message !== "string" || !rule.message) {
        throw new Error(`${name}: export a message that says what to do instead`);
      }
      if (!Array.isArray(rule.include) || rule.include.length === 0) {
        throw new Error(`${name}: export a non-empty include list of globs`);
      }
      if (rule.pattern instanceof RegExp === (typeof rule.count === "function")) {
        throw new Error(`${name}: export either a pattern or a count(text, path) function`);
      }
      return {
        name,
        message: rule.message,
        matches: pathMatcher(rule.include, rule.exclude ?? []),
        hits: rule.count ? countHits(name, rule.count) : patternHits(rule.pattern),
        baselinePath: path.join(dir, `${name}.baseline.json`),
      };
    }),
  );
}

// A file not yet staged is checked too, so a local run sees new files. CI has none, and listing
// them costs more than the rest of the run, so it skips that walk.
const UNTRACKED = process.env.CI ? [] : ["--others", "--exclude-standard"];

export function repoFiles(root = repoRoot) {
  return execFileSync("git", ["ls-files", "-z", "--cached", ...UNTRACKED], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\0")
    .filter(Boolean);
}

/**
 * Reads each file once and runs every rule that includes it.
 * Returns Map<rule name, Map<path, hits>>, holding only files with at least one hit.
 */
export function scan(rules, files, root = repoRoot) {
  const found = new Map(rules.map((rule) => [rule.name, new Map()]));
  for (const file of files) {
    const applicable = rules.filter((rule) => rule.matches(file));
    if (applicable.length === 0) continue;
    let text;
    try {
      text = readFileSync(path.join(root, file), "utf8");
    } catch (error) {
      // Deleted in the working tree but still in the index, or a submodule directory.
      if (error.code === "ENOENT" || error.code === "EISDIR") continue;
      throw error;
    }
    for (const rule of applicable) {
      const hits = rule.hits(text, file);
      if (hits.length > 0) found.get(rule.name).set(file, hits);
    }
  }
  return found;
}

export function readBaseline(rule) {
  return existsSync(rule.baselinePath) ? JSON.parse(readFileSync(rule.baselinePath, "utf8")) : {};
}

/** Sorted keys, one entry per line, so parallel pull requests rarely touch the same lines. */
export function formatBaseline(baseline) {
  const sorted = Object.fromEntries(
    Object.entries(baseline).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** Files whose count is above what the baseline allows; a file absent from it is allowed 0. */
export function violations(baseline, found) {
  return [...found]
    .map(([file, hits]) => ({ file, hits, allowed: baseline[file] ?? 0 }))
    .filter(({ hits, allowed }) => hits.length > allowed);
}

export function report(rule, offenders) {
  const lines = [`${rule.name}: ${rule.message}`];
  for (const { file, hits, allowed } of offenders) {
    if (allowed > 0) lines.push(`  ${file}: ${hits.length} found, ${allowed} allowed`);
    for (const hit of hits) lines.push(`  ${file}:${hit.line}  ${hit.text}`);
  }
  return lines.join("\n");
}

/** Lowers each entry to the current count and drops files that are gone or clean. Never raises. */
export function tighten(baseline, found) {
  const next = {};
  for (const [file, allowed] of Object.entries(baseline)) {
    const current = found.get(file)?.length ?? 0;
    if (current > 0) next[file] = Math.min(allowed, current);
  }
  return next;
}

function patternHits(pattern) {
  const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  return (text) => {
    const hits = [];
    let line = 1;
    let lineStart = 0;
    for (const match of text.matchAll(global)) {
      for (
        let newline = text.indexOf("\n", lineStart);
        newline !== -1 && newline < match.index;
        newline = text.indexOf("\n", lineStart)
      ) {
        line += 1;
        lineStart = newline + 1;
      }
      const lineEnd = text.indexOf("\n", match.index);
      const source = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      hits.push({ line, text: excerpt(source) });
    }
    return hits;
  };
}

/** A count function returns its hits, so a failure can point at each one. */
function countHits(name, count) {
  return (text, file) => {
    const hits = count(text, file);
    if (!Array.isArray(hits)) {
      throw new Error(`${name}: count(text, path) must return a list of { line, text } hits`);
    }
    return hits;
  };
}

function excerpt(source) {
  const trimmed = source.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

function pathMatcher(include, exclude) {
  const included = globsToRegExp(include);
  const excluded = exclude.length > 0 ? globsToRegExp(exclude) : null;
  return (file) => included.test(file) && !excluded?.test(file);
}

/** Globs over repo-relative paths: `**` crosses directories, `*` and `?` do not, `{a,b}` alternates. */
function globsToRegExp(globs) {
  const sources = globs.map((glob) =>
    glob.replace(/\*\*\/|\*\*|\*|\?|\{|\}|,|[.+^$()|[\]\\]/g, (token) => {
      if (token === "**/") return "(?:.*/)?";
      if (token === "**") return ".*";
      if (token === "*") return "[^/]*";
      if (token === "?") return "[^/]";
      if (token === "{") return "(?:";
      if (token === "}") return ")";
      if (token === ",") return "|";
      return `\\${token}`;
    }),
  );
  return new RegExp(`^(?:${sources.join("|")})$`);
}

async function main(args) {
  const rules = await loadRules();
  const found = scan(rules, repoFiles());
  if (args[0] === "--tighten") {
    for (const rule of rules) {
      if (!existsSync(rule.baselinePath)) continue;
      writeFileSync(
        rule.baselinePath,
        formatBaseline(tighten(readBaseline(rule), found.get(rule.name))),
      );
    }
    return;
  }
  if (args[0] === "--freeze" && args[1]) {
    const rule = rules.find((candidate) => candidate.name === args[1]);
    if (!rule) throw new Error(`No rule named ${args[1]} in scripts/checks/ratchets/`);
    if (existsSync(rule.baselinePath)) {
      throw new Error(`${rule.name} already has a baseline; --freeze only writes the first one`);
    }
    const counts = Object.fromEntries(
      [...found.get(rule.name)].map(([file, hits]) => [file, hits.length]),
    );
    writeFileSync(rule.baselinePath, formatBaseline(counts));
    return;
  }
  throw new Error("Usage: node scripts/checks/ratchets.mjs --tighten | --freeze <rule-name>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
