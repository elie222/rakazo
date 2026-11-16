// Core is imported by the web app, the mobile app and the desktop renderer. Its Node-only modules
// live in packages/core/src/node and are exported only under @rakazo/core/node/*, so the main
// barrel and every other subpath stay safe to bundle for a browser.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CORE_SRC = "packages/core/src/";
const NODE_DIR = `${CORE_SRC}node/`;
const IMPORT =
  /(?:^|[\s;])(?:import|export)\b[^"'`;]*?["']([^"'\n]+)["']|\bimport\(\s*["']([^"'\n]+)["']/g;

/** The Node-only specifiers a source imports: builtins, and modules in core's node directory. */
function nodeImports(file, source) {
  const found = [];
  for (const match of source.matchAll(IMPORT)) {
    const specifier = match[1] ?? match[2];
    if (/^import\s+type\b/.test(match[0].trim())) continue;
    const builtin =
      specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0]);
    const relative = /^\.\.?\//.test(specifier);
    const intoNodeDir =
      relative && `${path.posix.join(path.posix.dirname(file), specifier)}/`.startsWith(NODE_DIR);
    if (builtin || intoNodeDir) found.push(specifier);
  }
  return found;
}

const isTest = (file) => /\.(?:test|spec)\.[^/]+$|test-support[^/]*$/.test(file);

test("core outside src/node imports no Node builtin or Node-only module", () => {
  const files = execFileSync("git", ["ls-files", "-z", CORE_SRC], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => /\.tsx?$/.test(file) && !file.startsWith(NODE_DIR) && !isTest(file));
  const offenders = files.flatMap((file) =>
    nodeImports(file, readFileSync(path.join(root, file), "utf8")).map(
      (specifier) => `${file} -> ${specifier}`,
    ),
  );
  assert.deepEqual(
    offenders,
    [],
    "Move Node-only code into packages/core/src/node and export it under @rakazo/core/node/*.",
  );
});

test("only @rakazo/core/node/* exports reach src/node, and they reach nothing else", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "packages/core/package.json"), "utf8"));
  const misplaced = Object.entries(manifest.exports).filter(([key, target]) => {
    const file = typeof target === "string" ? target : target.default;
    return key.startsWith("./node/") !== file.startsWith("./src/node/");
  });
  assert.deepEqual(misplaced, []);
});

test("finds builtins and node-directory imports, and skips type-only imports", () => {
  const source = [
    'import { createHash } from "node:crypto";',
    'import path from "path";',
    'import type { Stats } from "node:fs";',
    'import { load } from "./node/load-root-env.js";',
    'export { x } from "./message-text.js";',
    'const lazy = await import("node:os");',
  ].join("\n");
  assert.deepEqual(nodeImports(`${CORE_SRC}index.ts`, source), [
    "node:crypto",
    "path",
    "./node/load-root-env.js",
    "node:os",
  ]);
});
