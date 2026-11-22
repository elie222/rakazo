import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { otaEligibility, otaSummary } from "./mobile-ota.mjs";

const script = fileURLToPath(new URL("./mobile-ota.mjs", import.meta.url));
const BASE = "0123456789abcdef0123456789abcdef01234567";
const GERMAN = "packages/i18n/locales/de/messages.po";

function modified(files) {
  return files.map((file) => ({ status: "M", file }));
}

test("bundled JavaScript, TypeScript and shared CSS ship over the air", () => {
  const files = [
    "apps/mobile/app/(tabs)/index.tsx",
    "apps/mobile/components/deep/nested/Card.tsx",
    "apps/mobile/lib/query/query.ts",
    "apps/mobile/index.ts",
    "packages/chat-ui/src/theme.css",
    "packages/ui-tokens/src/tokens.ts",
    "packages/contracts/src/rpc/app-contract.ts",
    "packages/core/src/time.ts",
    "packages/logging/src/index.ts",
  ];
  assert.deepEqual(otaEligibility(modified(files)), { publish: true, blocked: [] });
});

test("bundled translation catalogs ship over the air on their own", () => {
  const files = [GERMAN, "packages/i18n/locales/zh-TW/messages.po"];
  assert.deepEqual(otaEligibility(modified(files)), { publish: true, blocked: [] });
});

test("unused catalogs and unverified catalog changes block OTA", () => {
  const files = [
    { status: "M", file: "packages/i18n/locales/unused/messages.po" },
    { status: "A", file: GERMAN },
    { status: "D", file: GERMAN },
    { status: "T", file: GERMAN },
  ];
  for (const change of files) {
    assert.deepEqual(otaEligibility([change]), { publish: false, blocked: [change.file] });
  }

  assert.deepEqual(otaEligibility(modified(["apps/mobile/lib/i18n/i18n.ts", GERMAN])), {
    publish: false,
    blocked: [GERMAN],
  });
});

test("a deletion blocks the remaining bundled changes", () => {
  const file = "apps/mobile/lib/query/query.ts";
  assert.deepEqual(otaEligibility([{ status: "D", file }, ...modified([GERMAN])]), {
    publish: false,
    blocked: [file],
  });
});

test("files that never ship are ignored", () => {
  const files = [
    "apps/mobile/lib/query/query.test.ts",
    "apps/mobile/components/Card.test.tsx",
    "packages/core/src/time.test.js",
    "packages/contracts/src/env.d.ts",
    "apps/mobile/README.md",
    "apps/mobile/.maestro/flow.yaml",
    "apps/mobile/e2e/login.yaml",
  ];
  assert.deepEqual(otaEligibility(modified(files)), { publish: false, blocked: [] });
  assert.deepEqual(otaEligibility([]), { publish: false, blocked: [] });
});

test("anything else that changed blocks the update", () => {
  const blocked = [
    "apps/mobile/app.json",
    "apps/mobile/app.config.ts",
    "apps/mobile/metro.config.js",
    "apps/mobile/package.json",
    "apps/mobile/assets/icon.png",
    "apps/mobile/app/styles.css",
    "packages/core/src/data.json",
    "packages/core/package.json",
    "packages/logging/src/style.css",
    "packages/i18n/package.json",
    "packages/i18n/src/meeting.ts",
    "packages/i18n/locales/de/extra.po",
    "packages/ui-web/locales/de/messages.po",
    "pnpm-lock.yaml (mobile dependency tree)",
  ];
  assert.deepEqual(otaEligibility(modified(["apps/mobile/lib/query/query.ts", ...blocked])), {
    publish: false,
    blocked,
  });
});

test("the summary explains the decision against the base commit", () => {
  assert.equal(
    otaSummary(BASE, {
      publish: false,
      blocked: ["apps/mobile/app.json", "pnpm-lock.yaml (mobile dependency tree)"],
    }),
    [
      "### Mobile OTA skipped",
      "",
      "Since `012345678`, the last update installed builds run, these native-sensitive files changed:",
      "",
      "- `apps/mobile/app.json`",
      "- `pnpm-lock.yaml (mobile dependency tree)`",
      "",
      "Ship new iOS and Android builds, or publish by hand once the JavaScript is confirmed safe on the current builds.",
      "",
    ].join("\n"),
  );
  assert.equal(
    otaSummary(BASE, { publish: true, blocked: [] }),
    "### Mobile OTA eligible\n\nSince `012345678`, only the mobile bundle's JavaScript, TypeScript, stylesheets, or translation catalogs changed.\n",
  );
  assert.equal(
    otaSummary(BASE, { publish: false, blocked: [] }),
    "### No mobile OTA needed\n\nNothing in the shipped mobile bundle changed since `012345678`.\n",
  );
});

test("the command line writes the step summary and the publish output", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "mobile-ota-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const summary = path.join(dir, "summary.md");
  const output = path.join(dir, "output");
  writeFileSync(summary, "earlier\n");
  writeFileSync(output, "");
  execFileSync("node", [script, BASE, summary, output], {
    input: ["M", "apps/mobile/lib/query/query.ts", ""].join("\0"),
  });
  assert.equal(readFileSync(output, "utf8"), "publish=true\n");
  assert.match(readFileSync(summary, "utf8"), /^earlier\n### Mobile OTA eligible\n/);
});

test("an incomplete diff cannot produce an eligibility result", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "mobile-ota-malformed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const summary = path.join(dir, "summary.md");
  const output = path.join(dir, "output");
  writeFileSync(output, "");
  assert.throws(
    () =>
      execFileSync("node", [script, BASE, summary, output], {
        input: ["M", GERMAN, "D", ""].join("\0"),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    /Malformed mobile OTA diff/,
  );
  assert.equal(readFileSync(output, "utf8"), "");
});
