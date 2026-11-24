// Unit tests for bundle-size.mjs against a fake build output. The check itself needs a real build,
// so it runs after `pnpm build` in CI and not here.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkBundleSizes } from "./bundle-size.mjs";

const BUDGETS = { "web-startup": 10, "desktop-main": 10 };

// Random bytes do not compress, so a file's gzipped size is its length plus a few header bytes.
function fakeBuild(t, sizes = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "bundle-size-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  const { entry = 3000, vendor = 2000, styles = 1000, lazy = 500_000, main = 4000 } = sizes;
  write(
    "apps/web/dist/index.html",
    `<!doctype html>
<html>
  <head>
    <link rel="icon" href="/favicon.ico" />
    <script src="/theme.js"></script>
    <script type="module" crossorigin src="/assets/index-a1b2c3.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-d4e5f6.js">
    <link rel="stylesheet" crossorigin href="/assets/index-g7h8i9.css">
  </head>
</html>`,
  );
  write("apps/web/dist/favicon.ico", randomBytes(100_000));
  write("apps/web/dist/theme.js", randomBytes(100));
  write("apps/web/dist/assets/index-a1b2c3.js", randomBytes(entry));
  write("apps/web/dist/assets/vendor-d4e5f6.js", randomBytes(vendor));
  write("apps/web/dist/assets/index-g7h8i9.css", randomBytes(styles));
  write("apps/web/dist/assets/SettingsPage-j0k1l2.js", randomBytes(lazy));
  write("apps/desktop/dist/launch.js", randomBytes(0));
  write("apps/desktop/dist/main.js", randomBytes(main));
  write("apps/desktop/dist/main.js.map", randomBytes(100_000));
  write("apps/desktop/dist/preload.cjs", randomBytes(200));
  write("apps/desktop/dist/setup-preload.cjs", randomBytes(100));
  return root;
}

test("passes when the startup set fits, whatever the lazily loaded chunks weigh", (t) => {
  const { passed, failures } = checkBundleSizes(fakeBuild(t), BUDGETS);
  assert.deepEqual(failures, []);
  assert.equal(passed.length, 2);
  assert.match(passed[0], /^web-startup: 6\.\d kB of 10\.0 kB$/);
  assert.equal(passed[1], "desktop-main: 4.3 kB of 10.0 kB");
});

test("an over-budget web startup names the budget, the sizes, the largest files and the fix", (t) => {
  const { passed, failures } = checkBundleSizes(fakeBuild(t, { vendor: 9000 }), BUDGETS);
  assert.deepEqual(passed, ["desktop-main: 4.3 kB of 10.0 kB"]);
  assert.equal(failures.length, 1);
  const [failure] = failures;
  assert.match(failure, /^Over budget: web-startup, web startup \(/);
  assert.match(failure, /Measured 13\.\d kB, limit 10\.0 kB, over by 3\.\d kB\./);
  const largest = failure.split("\n").filter((line) => line.includes("apps/web/dist/"));
  assert.deepEqual(
    largest.map((line) => line.trim().split(/\s+/).at(-1)),
    [
      "apps/web/dist/assets/vendor-d4e5f6.js",
      "apps/web/dist/assets/index-a1b2c3.js",
      "apps/web/dist/assets/index-g7h8i9.css",
      "apps/web/dist/theme.js",
    ],
  );
  assert.match(largest[0], /9\.0 kB/);
  assert.match(failure, /dynamic import\(\)/);
  assert.match(
    failure,
    /or raise "web-startup" in scripts\/checks\/bundle-size\.budgets\.json and give the reason in the PR\./,
  );
});

test("an over-budget desktop bundle says how its one-file bundle can shrink", (t) => {
  const { failures } = checkBundleSizes(fakeBuild(t, { main: 20_000 }), BUDGETS);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^Over budget: desktop-main, /);
  assert.match(failures[0], /Measured 20\.3 kB, limit 10\.0 kB, over by 10\.3 kB\./);
  assert.match(failures[0], /20\.0 kB {2}apps\/desktop\/dist\/main\.js/);
  assert.match(failures[0], /"external" in apps\/desktop\/scripts\/build\.mjs/);
  assert.match(failures[0], /raise "desktop-main" in scripts\/checks\/bundle-size\.budgets\.json/);
});

test("missing build output says to run the build", (t) => {
  const empty = mkdtempSync(path.join(tmpdir(), "bundle-size-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.deepEqual(checkBundleSizes(empty, BUDGETS), {
    passed: [],
    failures: [
      "Cannot measure web-startup: apps/web/dist/index.html is missing. Run the build first: pnpm --filter @rakazo/web build",
      "Cannot measure desktop-main: apps/desktop/dist/launch.js is missing. Run the build first: pnpm --filter @rakazo/desktop build",
    ],
  });

  const partial = fakeBuild(t);
  rmSync(path.join(partial, "apps/web/dist/assets/vendor-d4e5f6.js"));
  assert.match(
    checkBundleSizes(partial, BUDGETS).failures[0],
    /^Cannot measure web-startup: apps\/web\/dist\/assets\/vendor-d4e5f6\.js is missing\. Run the build first/,
  );
});

test("every measured bundle has a committed budget", (t) => {
  const budgets = JSON.parse(
    readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "bundle-size.budgets.json"),
      "utf8",
    ),
  );
  assert.deepEqual(checkBundleSizes(fakeBuild(t), budgets).failures, []);
  assert.deepEqual(checkBundleSizes(fakeBuild(t), {}).failures, [
    'No budget for "web-startup" in scripts/checks/bundle-size.budgets.json.',
    'No budget for "desktop-main" in scripts/checks/bundle-size.budgets.json.',
  ]);
});
