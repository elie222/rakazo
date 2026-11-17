// Freezes the package layering by walking the imports of every tracked source file. Violations
// that predate a rule are frozen in import-boundaries.allowlist.json; anything new fails.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ALLOWLIST_FILE = "scripts/checks/import-boundaries.allowlist.json";
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|astro)$/;
const SCOPE = "@rakazo/";

const LEAF_PACKAGES = ["packages/contracts", "packages/logging", "packages/ui-tokens"];
const CORE = "packages/core";
const CORE_MAY_IMPORT = ["packages/contracts", "packages/ui-tokens"];
const SERVER_PACKAGES = [
  "packages/adapter-kit",
  "packages/adapters",
  "packages/auth",
  "packages/db",
  "packages/memory",
];
const CLIENT_CODE = [
  "apps/mobile",
  "apps/web",
  "packages/chat-ui",
  "packages/page-kit",
  "packages/ui-web",
];
const TESTKIT = "packages/testkit";
// The testkit is the integration harness: its tests drive the whole API and the sandbox
// supervisor, by name and through their exports maps. Tests that need an app live there.
const TESTKIT_MAY_IMPORT = ["apps/api", "infra/sandboxes/supervisor"];
// Code that runs on a server or in a desktop main process, beside the browser code of the same app.
// Server code may import server packages; browser code may import neither.
const SERVER_DIRS = ["apps/desktop/src/main", "apps/web/server"];
const BROWSER_CODE = [
  "apps/desktop/src/preload",
  "apps/desktop/src/setup-renderer",
  "apps/mobile",
  "apps/web/src",
  "packages/chat-ui",
  "packages/page-kit",
  "packages/ui-web",
];
// Core's Node-only modules, kept out of its main barrel.
const SERVER_SUBPATH = /^@rakazo\/core\/node(?:\/|$)/;
// The desktop build bundles workspace code into its output, and the packager copies every
// package under "dependencies" into the app, so bundled packages belong in devDependencies.
const BUNDLED = ["apps/desktop"];
// Each provider implementation lives in providers/<family>/<provider id>/ and stands alone.
const PROVIDER_FOLDER = /^packages\/adapters\/src\/providers\/[^/]+\/[^/]+\//;

const under = (dirs, file) => dirs.some((dir) => file.startsWith(`${dir}/`));

/** The one definition of test code: it may import the testkit and use devDependencies. */
function isTestCode(file) {
  return (
    file.startsWith(`${TESTKIT}/`) ||
    /(?:^|\/)e2e\//.test(file) ||
    /\.(?:test|spec)\.[^/]+$/.test(file) ||
    /test-support[^/]*$/.test(file)
  );
}

const RULES = {
  leaf: {
    title: "leaf packages import no workspace package",
    fix: "contracts, logging and ui-tokens sit at the bottom of the graph. Move the code that needs this import up into the package that owns the dependency.",
  },
  core: {
    title: "core imports only contracts and ui-tokens",
    fix: "Keep core free of server and UI packages: take the value as an argument, or move this code to the package that owns the dependency.",
  },
  app: {
    title: "packages never import an app or an infra service",
    fix: "Move the shared piece into a package and import it from both sides. A test that needs the whole API belongs in the testkit and imports it by name.",
  },
  testkit: {
    title: "non-test code never imports the testkit",
    fix: "Shipped code cannot depend on test helpers. Move the helper into the package that owns it, or make the importing file test code (*.test.*, *.spec.*, e2e/, *test-support*).",
  },
  relative: {
    title: "relative imports stay inside their own package",
    fix: "Import the package by name through its exports map; if the symbol is not exported, export it deliberately.",
  },
  exports: {
    title: "imports go through a package's exports map",
    fix: "Import a subpath the package exports; if none fits, add one to its package.json exports deliberately.",
  },
  runtime: {
    title: "browser and renderer code never imports server or main-process code",
    fix: "Code a page loads is bundled for the browser. Move what both sides need out of the server or main-process directory, or reach it over RPC or IPC.",
  },
  server: {
    title: "UI packages and client apps never import server packages",
    fix: "Client code reaches this through the API: add it in apps/api and call it over RPC, with shared types in @rakazo/contracts.",
  },
  vendor: {
    title: "a provider's folder never imports another provider's folder",
    fix: "Move what both providers need into shared adapter code outside packages/adapters/src/providers/, and import it from there.",
  },
  undeclared: {
    title: "imported workspace packages are declared dependencies",
    fix: 'Add it to this package.json as "workspace:*": under dependencies when shipped code imports it, under devDependencies when only tests do.',
  },
  unused: {
    title: "declared workspace dependencies are imported",
    fix: "Nothing in this package imports it. Remove it from this package.json.",
  },
  lazy: {
    title: "a package loaded with import() is never imported statically",
    fix: "Optional packages load only once configured (AGENTS.md). Import it with import() where it is needed, or with import type for types; a dev script or test may import it statically.",
  },
};

const REGEX_LITERAL = String.raw`(?<=(?:[(,=:\[!&|?{;>]|return)\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/`;
const BINDINGS = String.raw`(?:[\w$]+|\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})(?:\s*,\s*(?:\*\s*as\s+[\w$]+|\{[^}]*\}))?`;
// \x60 is a backtick.
const TEMPLATE_REST = String.raw`(?:\\[\s\S]|[^\\\x60])*`;
// One left-to-right pass. Comments, strings, templates and regex literals are consumed as they
// are met, so the word "import" inside them is never read as code.
const TOKEN = new RegExp(
  [
    String.raw`\/\/[^\n]*`,
    String.raw`\/\*[\s\S]*?\*\/`,
    REGEX_LITERAL,
    String.raw`(?<![\w$.])(?:import|export)\b\s*(?:type\s+)?(?:${BINDINGS}\s*from\s*)?["']([^"'\n]+)["']`,
    // A template specifier is cut at its first interpolation, which still shows where it points.
    String.raw`(?<![\w$.])(?:import|require)\s*\(\s*(?:["']([^"'\n]+)["']|\x60([^\x60$\\]+)(?:\$\{${TEMPLATE_REST})?\x60)`,
    String.raw`"(?:\\.|[^"\\\n])*"`,
    String.raw`'(?:\\.|[^'\\\n])*'`,
    String.raw`\x60${TEMPLATE_REST}\x60`,
  ].join("|"),
  "g",
);

/**
 * Every import, re-export, import() and require() in a source text, in order. `kind` is "type"
 * for a type-only import or export, "dynamic" for import(), and "static" otherwise.
 */
function extractImports(source) {
  const imports = [];
  for (const match of source.matchAll(TOKEN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier) continue;
    const kind = match[1]
      ? /^(?:import|export)\s+type\b/.test(match[0])
        ? "type"
        : "static"
      : match[0].startsWith("import")
        ? // `typeof import("pkg")` is a type query: it loads nothing.
          /\btypeof\s*$/.test(source.slice(Math.max(0, match.index - 16), match.index))
          ? "type"
          : "dynamic"
        : "static";
    imports.push({ specifier, kind });
  }
  return imports;
}

/** The specifier of every import, re-export, import() and require() in a source text. */
function extractSpecifiers(source) {
  return extractImports(source).map(({ specifier }) => specifier);
}

/** The npm package a bare specifier names, or undefined for paths, builtins and workspace code. */
function externalPackage(specifier) {
  if (/^[./]/.test(specifier) || specifier.startsWith("node:") || specifier.startsWith(SCOPE)) {
    return undefined;
  }
  const name = specifier.split("/", specifier.startsWith("@") ? 2 : 1).join("/");
  return builtinModules.includes(name) ? undefined : name;
}

/**
 * Shipped code that statically imports a package other shipped code loads with import(). The
 * dynamic import is what keeps an optional vendor SDK out of processes that never configure it,
 * and one static import anywhere loads it everywhere.
 */
function findEagerImports(sources) {
  // Client bundles split code with import() for load time, not to leave a package out.
  const client = [...CLIENT_CODE, ...BUNDLED, "apps/www"];
  const shipped = sources.filter(
    ({ file }) =>
      !isTestCode(file) &&
      !/(?:^|\/)scripts\//.test(file) &&
      !client.some((dir) => file.startsWith(`${dir}/`)),
  );
  const lazy = new Set(
    shipped.flatMap(({ imports }) =>
      imports
        .filter(({ kind }) => kind === "dynamic")
        .map(({ specifier }) => externalPackage(specifier)),
    ),
  );
  lazy.delete(undefined);
  return shipped.flatMap(({ file, imports }) =>
    imports
      .filter(({ kind, specifier }) => kind === "static" && lazy.has(externalPackage(specifier)))
      .map(({ specifier }) => ({ rule: "lazy", file, specifier })),
  );
}

function describeWorkspace(dir, manifest) {
  const names = (...groups) =>
    groups.flatMap((group) => Object.keys(group ?? {})).filter((name) => name.startsWith(SCOPE));
  return {
    dir,
    name: manifest.name,
    exports: typeof manifest.exports === "object" ? Object.keys(manifest.exports) : undefined,
    dependencies: names(manifest.dependencies, manifest.peerDependencies),
    devDependencies: names(manifest.devDependencies),
  };
}

/** The packages pnpm-workspace.yaml lists, among the tracked files. */
function loadWorkspaces(files) {
  const yaml = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const [, list] = /^packages:\n((?:[ \t]+-.*\n)+)/m.exec(yaml);
  const manifests = [...list.matchAll(/-\s*["']?([^"'\s]+)/g)].map(
    ([, glob]) => new RegExp(`^${glob.replaceAll("*", "[^/]+")}/package\\.json$`),
  );
  return files
    .filter((file) => manifests.some((manifest) => manifest.test(file)))
    .map((file) =>
      describeWorkspace(
        path.posix.dirname(file),
        JSON.parse(readFileSync(path.join(root, file), "utf8")),
      ),
    );
}

function isExported(workspace, subpath) {
  if (!workspace.exports) return true;
  return workspace.exports.some((key) => {
    if (!key.includes("*")) return key === subpath;
    const [before, after] = key.split("*");
    return subpath.startsWith(before) && subpath.endsWith(after);
  });
}

/**
 * Every broken rule in the given sources, as [{ rule, file, specifier }]. A dependency finding
 * names the package.json as the file and the package as the specifier.
 */
function findViolations(sources, workspaces) {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const byDir = new Map(workspaces.map((workspace) => [workspace.dir, workspace]));
  const dirs = [...byDir.keys()].sort((a, b) => b.length - a.length);
  // "" is the repo root: scripts and config that belong to no workspace package.
  const ownerOf = (file) => dirs.find((dir) => file.startsWith(`${dir}/`)) ?? "";
  const violations = [];
  const usage = new Map(
    dirs.map((dir) => [dir, { shipped: new Set(), named: new Set(), any: new Set() }]),
  );

  for (const { file, specifiers } of sources) {
    const owner = ownerOf(file);
    const testCode = isTestCode(file);
    for (const specifier of specifiers) {
      const flag = (rule) => violations.push({ rule, file, specifier });
      let target;
      const relative = /^\.\.?(?:\/|$)/.test(specifier);
      const browser = under(BROWSER_CODE, file) && !testCode;
      if (relative) {
        const resolved = path.posix.join(path.posix.dirname(file), specifier);
        target = resolved.startsWith("..") ? undefined : ownerOf(`${resolved}/`);
        if (target !== owner) flag("relative");
        const provider = PROVIDER_FOLDER.exec(file)?.[0];
        const targetProvider = PROVIDER_FOLDER.exec(`${resolved}/`)?.[0];
        if (provider && targetProvider && provider !== targetProvider) flag("vendor");
        if (browser && under(SERVER_DIRS, resolved)) flag("runtime");
      } else {
        if (browser && SERVER_SUBPATH.test(specifier)) flag("runtime");
        const workspace = byName.get(specifier.split("/", 2).join("/"));
        if (!workspace) continue;
        target = workspace.dir;
        const subpath = `.${specifier.slice(workspace.name.length)}`;
        if (target !== owner && !isExported(workspace, subpath)) flag("exports");
      }
      if (!target || target === owner) continue;

      const used = usage.get(owner);
      if (used) {
        // A relative import counts as use: the build cache keys on declared dependencies, so a
        // package reached by path must stay declared until that import goes through its name.
        used.any.add(target);
        if (!relative) used.named.add(target);
        if (!relative && !testCode) used.shipped.add(target);
      }
      if (LEAF_PACKAGES.includes(owner)) flag("leaf");
      if (owner === CORE && !CORE_MAY_IMPORT.includes(target)) flag("core");
      if (owner.startsWith("packages/") && !target.startsWith("packages/")) {
        const harness = owner === TESTKIT && !relative && TESTKIT_MAY_IMPORT.includes(target);
        if (!harness) flag("app");
      }
      if (target === TESTKIT && !testCode) flag("testkit");
      // Browser end-to-end specs run in Node and may seed the database.
      const client = CLIENT_CODE.includes(owner) && !under(SERVER_DIRS, file);
      if (SERVER_PACKAGES.includes(target) && client && !testCode) {
        flag("server");
      }
    }
  }

  for (const workspace of workspaces) {
    const used = usage.get(workspace.dir);
    const file = `${workspace.dir}/package.json`;
    const dirOf = (name) => byName.get(name)?.dir;
    const declared = [...workspace.dependencies, ...workspace.devDependencies];
    const shippable = BUNDLED.includes(workspace.dir) ? declared : workspace.dependencies;
    for (const target of used.named) {
      const names = used.shipped.has(target) ? shippable : declared;
      if (!names.some((name) => dirOf(name) === target)) {
        violations.push({ rule: "undeclared", file, specifier: byDir.get(target).name });
      }
    }
    for (const name of declared) {
      if (!used.any.has(dirOf(name))) violations.push({ rule: "unused", file, specifier: name });
    }
  }
  return violations;
}

const entry = ({ file, specifier }) => `${file} -> ${specifier}`;

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 << 20,
})
  .split("\0")
  .filter(Boolean);
const sources = tracked
  .filter((file) => SOURCE_FILE.test(file))
  .map((file) => {
    const imports = extractImports(readFileSync(path.join(root, file), "utf8"));
    return { file, imports, specifiers: imports.map(({ specifier }) => specifier) };
  });
const violations = [
  ...findViolations(sources, loadWorkspaces(tracked)),
  ...findEagerImports(sources),
];
const allowlist = JSON.parse(readFileSync(path.join(root, ALLOWLIST_FILE), "utf8"));

for (const [rule, { title, fix }] of Object.entries(RULES)) {
  const allowed = allowlist[rule] ?? [];
  const found = new Set(violations.filter((violation) => violation.rule === rule).map(entry));
  const list = (lines) => lines.map((line) => `  ${line}`).join("\n");
  test(title, () => {
    const fresh = [...found].filter((line) => !allowed.includes(line)).sort();
    assert.ok(fresh.length === 0, `\nRule: ${title}\n${list(fresh)}\nFix: ${fix}\n`);
  });
  test(`allowlist for "${rule}" holds only live violations, sorted`, () => {
    const stale = allowed.filter((line) => !found.has(line));
    assert.ok(
      stale.length === 0,
      `\nNo longer a violation; delete from "${rule}" in ${ALLOWLIST_FILE}:\n${list(stale)}\n`,
    );
    assert.deepEqual(allowed, [...new Set(allowed)].sort(), `Keep "${rule}" sorted`);
  });
}

test("the allowlist names only known rules", () => {
  assert.deepEqual(
    Object.keys(allowlist).filter((rule) => !RULES[rule]),
    [],
  );
});

test("extracts specifiers from every import form and ignores look-alikes", () => {
  const source = [
    'import "./side-effect";',
    'import fs from "node:fs";',
    'import type { A } from "./types";',
    "import React, {",
    "  useState, // a comment inside the list",
    "  useEffect,",
    '} from "react";',
    "import * as ns from './namespace';",
    'import main, * as rest from "./both";',
    'export * from "./star";',
    'export * as named from "./star-as";',
    'export { one, two as three } from "./named";',
    'export type { B } from "./type-export";',
    'const lazy = await import("./dynamic");',
    "const spaced = import(\n  './dynamic-multiline'\n);",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text
    "const locale = import(`./locales/${code}.js`);",
    'const legacy = require("./required");',
    'type Loaded = typeof import("./type-query");',
    '// import skipped from "./line-comment";',
    '/* import("./block-comment") */',
    '/**\n * import { x } from "./jsdoc";\n */',
    "const text = \"import x from './in-string'\";",
    'const sample = `\nimport y from "./in-template";\n`;',
    "const quote = /[\"'`]/.test(text);",
    'const after = import("./after-regex");',
    'export const value = "./not-a-re-export";',
    'object.import("./method-call");',
    "export default function importer() {}",
  ].join("\n");
  assert.deepEqual(extractSpecifiers(source), [
    "./side-effect",
    "node:fs",
    "./types",
    "react",
    "./namespace",
    "./both",
    "./star",
    "./star-as",
    "./named",
    "./type-export",
    "./dynamic",
    "./dynamic-multiline",
    "./locales/",
    "./required",
    "./type-query",
    "./after-regex",
  ]);
});

test("resolves specifiers to packages and reports each rule", () => {
  const scoped = (name) => `${SCOPE}${name}`;
  const workspace = (dir, dependencies = [], extra = {}) =>
    describeWorkspace(dir, {
      name: scoped(dir.split("/").at(-1)),
      exports: {
        ".": "./src/index.ts",
        "./components/*": "./src/components/*.tsx",
        "./node/*": "./src/node/*.ts",
      },
      dependencies: Object.fromEntries(dependencies.map((name) => [scoped(name), "workspace:*"])),
      ...extra,
    });
  const workspaces = [
    workspace("apps/api", ["core", "testkit"]),
    workspace("apps/desktop", [], { devDependencies: { [scoped("core")]: "workspace:*" } }),
    workspace("apps/web", ["ui-web", "db", "contracts"], {
      devDependencies: { [scoped("core")]: "workspace:*" },
    }),
    workspace("packages/contracts", ["core"]),
    workspace("packages/core", ["contracts", "db"]),
    workspace("packages/db", ["api"]),
    workspace(TESTKIT, ["api", "web"]),
    workspace("packages/ui-web", ["contracts"]),
  ];
  const sources = [
    { file: "apps/api/src/index.ts", specifiers: [scoped("core"), scoped("testkit")] },
    { file: "apps/api/src/index.test.ts", specifiers: [scoped("testkit"), "./index.js"] },
    { file: "apps/desktop/src/main/main.ts", specifiers: [scoped("core")] },
    {
      file: "apps/web/src/app.tsx",
      specifiers: [
        scoped("ui-web/components/button"),
        scoped("ui-web/src/internal"),
        scoped("db"),
        scoped("core"),
        "../../../packages/contracts/src/index.ts",
        "@rakazo-other/unrelated",
      ],
    },
    { file: "apps/web/e2e/seed.spec.ts", specifiers: [scoped("db")] },
    {
      file: "apps/web/src/page.tsx",
      specifiers: ["../server/proxy.js", scoped("core/node/screen"), scoped("core")],
    },
    { file: "apps/web/src/page.test.tsx", specifiers: ["../server/proxy.js"] },
    { file: "apps/desktop/src/preload/preload.cjs", specifiers: ["../main/ipc.js"] },
    {
      file: "apps/web/server/proxy.ts",
      specifiers: [scoped("db"), scoped("core/node/screen"), "../src/shared.js"],
    },
    { file: "packages/contracts/src/index.ts", specifiers: [scoped("core")] },
    { file: "packages/core/src/index.ts", specifiers: [scoped("contracts"), scoped("db")] },
    { file: "packages/db/src/index.ts", specifiers: [scoped("api")] },
    {
      file: `${TESTKIT}/src/index.ts`,
      specifiers: [scoped("api"), "../../../apps/api/src/app.ts"],
    },
    { file: `${TESTKIT}/src/browser.ts`, specifiers: [scoped("web")] },
    { file: "scripts/build.mjs", specifiers: ["../packages/core/src/index.ts", "./pnpm.mjs"] },
    {
      file: "packages/adapters/src/providers/computer/one/one-sandbox.ts",
      specifiers: ["./one-errors.js", "../../../sandbox-errors.js", "../two/two-sandbox.js"],
    },
  ];
  assert.deepEqual(
    findViolations(sources, workspaces)
      .map((violation) => `${violation.rule}: ${entry(violation)}`)
      .sort(),
    [
      "app: packages/db/src/index.ts -> @rakazo/api",
      "app: packages/testkit/src/browser.ts -> @rakazo/web",
      "app: packages/testkit/src/index.ts -> ../../../apps/api/src/app.ts",
      "core: packages/core/src/index.ts -> @rakazo/db",
      "exports: apps/web/src/app.tsx -> @rakazo/ui-web/src/internal",
      "leaf: packages/contracts/src/index.ts -> @rakazo/core",
      "relative: apps/web/src/app.tsx -> ../../../packages/contracts/src/index.ts",
      "relative: packages/testkit/src/index.ts -> ../../../apps/api/src/app.ts",
      "relative: scripts/build.mjs -> ../packages/core/src/index.ts",
      "runtime: apps/desktop/src/preload/preload.cjs -> ../main/ipc.js",
      "runtime: apps/web/src/page.tsx -> ../server/proxy.js",
      "runtime: apps/web/src/page.tsx -> @rakazo/core/node/screen",
      "server: apps/web/src/app.tsx -> @rakazo/db",
      "testkit: apps/api/src/index.ts -> @rakazo/testkit",
      "undeclared: apps/web/package.json -> @rakazo/core",
      "unused: packages/ui-web/package.json -> @rakazo/contracts",
      "vendor: packages/adapters/src/providers/computer/one/one-sandbox.ts -> ../two/two-sandbox.js",
    ],
  );
});

test("flags a static import of a package that server code loads with import()", () => {
  const source = (file, text) => ({ file, imports: extractImports(text) });
  const sources = [
    source("packages/adapters/src/vendor.ts", 'const sdk = await import("@vendor/sdk/client");'),
    source("packages/adapters/src/eager.ts", 'import { Client } from "@vendor/sdk";'),
    source("packages/adapters/src/types.ts", 'import type { Client } from "@vendor/sdk";'),
    source("packages/adapters/src/vendor.test.ts", 'import { Client } from "@vendor/sdk";'),
    source("packages/ui-tokens/scripts/build.ts", 'import { Client } from "@vendor/sdk";'),
    source("packages/adapters/src/node.ts", 'await import("node:fs"); import fs from "node:fs";'),
    source("apps/web/src/chart.tsx", 'await import("charts"); import "charts/style.css";'),
    source("apps/web/src/table.tsx", 'import { draw } from "charts";'),
    // A type query loads nothing, so it does not make "pg" a lazily loaded package.
    source("packages/db/src/pool.ts", 'type Pg = typeof import("pg");'),
    source("packages/db/src/database/client.ts", 'import { Pool } from "pg";'),
  ];
  assert.deepEqual(findEagerImports(sources).map(entry), [
    "packages/adapters/src/eager.ts -> @vendor/sdk",
  ]);
});
