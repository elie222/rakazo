// Optional vendor SDKs must load through dynamic import() only when configured (AGENTS.md).
// Bundles each server entry point the way production does and fails if a listed SDK is
// statically imported by the emitted bundle: bundling inlines workspace code, so a dynamic
// import() of a local module does not make that module's own static imports lazy.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { serverBuildOptions } from "./build-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = [
  "apps/api/src/index.ts",
  "apps/worker/src/index.ts",
  "infra/sandboxes/supervisor/src/index.ts",
  "infra/updater/src/index.ts",
];
// @chat-adapter/state-memory is left out: it is the Chat SDK's own in-memory state, which
// every messaging platform needs, not a vendor.
const OPTIONAL_VENDORS =
  /^(@aws-sdk\/.+|@daytona\/sdk|@e2b\/desktop|novita-sandbox|@composio\/core|@stripe\/link-sdk|@chat-adapter\/(slack|telegram|whatsapp)|@boatdev\/sdk|@boxd-sh\/sdk|chat-adapter-sendblue|@axiomhq\/js|@sentry\/node)$/;
// Known static imports still to make lazy. Remove an entry once its SDK loads on demand.
const PENDING = [
  "@chat-adapter/telegram",
  "@chat-adapter/whatsapp",
  // The wallet factory imports its module dynamically, but the bundle inlines that module,
  // so the SDK is a static import of every emitted server bundle.
  "@stripe/link-sdk",
];

// Vendor SDKs statically imported by each emitted bundle: Map<entry, Set<vendor>>.
const staticVendors = new Map();
for (const entry of ENTRIES) {
  const options = serverBuildOptions(path.join(root, entry), path.join(root, "dist/check.js"));
  const { metafile } = await build({
    ...options,
    absWorkingDir: root,
    write: false,
    sourcemap: false,
    metafile: true,
    logLevel: "silent",
  });
  const found = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const edge of output.imports ?? []) {
      if (edge.kind !== "import-statement") continue;
      const name = packageName(edge.path);
      if (OPTIONAL_VENDORS.test(name)) found.add(name);
    }
  }
  staticVendors.set(entry, found);
}

for (const [entry, found] of staticVendors) {
  test(`${entry} loads optional vendor SDKs only through dynamic import()`, () => {
    assert.deepEqual(
      [...found].filter((name) => !PENDING.includes(name)),
      [],
    );
  });
}

test("every pending vendor SDK is still statically imported somewhere", () => {
  // Narrower entry points (the supervisor and updater never load the messaging SDKs), so
  // debt is tracked across all entries, not per entry.
  const anywhere = new Set();
  for (const found of staticVendors.values()) {
    for (const name of found) anywhere.add(name);
  }
  assert.deepEqual(
    PENDING.filter((name) => !anywhere.has(name)),
    [],
    "Now loaded on demand; remove from PENDING",
  );
});

/**
 * The build rewrites bare specifiers to paths inside node_modules; recover the package name.
 * Anything else (node builtins, a bare specifier the rewrite missed) is returned as is.
 */
function packageName(external) {
  if (!external.includes("node_modules/")) return external;
  const [scope, name] = external.split("node_modules/").at(-1).split("/");
  return scope.startsWith("@") ? `${scope}/${name}` : scope;
}
