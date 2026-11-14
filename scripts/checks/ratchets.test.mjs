import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  formatBaseline,
  loadRules,
  readBaseline,
  repoFiles,
  report,
  scan,
  tighten,
  violations,
} from "./ratchets.mjs";

const rules = await loadRules();
const found = scan(rules, repoFiles());

for (const rule of rules) {
  test(`${rule.name}: no file is above its baseline`, () => {
    const offenders = violations(readBaseline(rule), found.get(rule.name));
    if (offenders.length === 0) return;
    const failure = new Error(report(rule, offenders));
    // The report is the whole story; a stack through the test runner only buries it.
    failure.stack = failure.message;
    throw failure;
  });

  test(`${rule.name}: baseline is sorted with one entry per line`, () => {
    const baseline = readBaseline(rule);
    for (const [file, allowed] of Object.entries(baseline)) {
      assert.ok(
        Number.isInteger(allowed) && allowed > 0,
        `${file}: allowed count must be 1 or more`,
      );
    }
    if (Object.keys(baseline).length === 0) return;
    assert.equal(
      readFileSync(rule.baselinePath, "utf8"),
      formatBaseline(baseline),
      "Run node scripts/checks/ratchets.mjs --tighten to rewrite it",
    );
  });
}

const fixture = mkdtempSync(path.join(tmpdir(), "ratchets-"));
after(() => rmSync(fixture, { recursive: true }));
mkdirSync(path.join(fixture, "rules"));
mkdirSync(path.join(fixture, "src"));
writeFileSync(
  path.join(fixture, "rules/no-sleep.mjs"),
  `export const message = "Wait on the condition.";
export const include = ["src/**/*.ts"];
export const exclude = ["**/*.test.ts"];
export const pattern = /sleep\\(/;
`,
);
writeFileSync(
  path.join(fixture, "rules/short-files.mjs"),
  `export const message = "Split the file.";
export const include = ["src/**"];
export const count = (text, file) =>
  text.split("\\n").length > 4 ? [{ line: 4, text: \`\${file} is too long\` }] : [];
`,
);
const sources = {
  "src/old.ts": "sleep(1);\nrun();\nsleep(2);\n",
  "src/new.ts": "run();\n  sleep(3); // settle\n",
  "src/clean.ts": "run();\n",
  "src/old.test.ts": "sleep(1);\n",
  "src/long.md": "1\n2\n3\n4\n",
};
for (const [file, text] of Object.entries(sources)) writeFileSync(path.join(fixture, file), text);

async function scanFixture() {
  const fixtureRules = await loadRules(path.join(fixture, "rules"));
  const hits = scan(fixtureRules, [...Object.keys(sources), "src/deleted.ts"], fixture);
  return { noSleep: fixtureRules[0], shortFiles: fixtureRules[1], hits };
}

test("a file above its baseline fails and one at or below it passes", async () => {
  const { noSleep, hits } = await scanFixture();
  const sleeps = hits.get("no-sleep");
  assert.deepEqual(
    violations({ "src/old.ts": 1, "src/new.ts": 1 }, sleeps).map(({ file }) => file),
    ["src/old.ts"],
  );
  assert.deepEqual(violations({ "src/old.ts": 2, "src/new.ts": 5, "src/gone.ts": 3 }, sleeps), []);
  assert.equal(
    report(noSleep, violations({ "src/old.ts": 1, "src/new.ts": 1 }, sleeps)),
    [
      "no-sleep: Wait on the condition.",
      "  src/old.ts: 2 found, 1 allowed",
      "  src/old.ts:1  sleep(1);",
      "  src/old.ts:3  sleep(2);",
    ].join("\n"),
  );
});

test("a hit in a file absent from the baseline fails", async () => {
  const { noSleep, shortFiles, hits } = await scanFixture();
  assert.equal(
    report(noSleep, violations({ "src/old.ts": 2 }, hits.get("no-sleep"))),
    "no-sleep: Wait on the condition.\n  src/new.ts:2  sleep(3); // settle",
  );
  assert.equal(
    report(shortFiles, violations({}, hits.get("short-files"))),
    "short-files: Split the file.\n  src/long.md:4  src/long.md is too long",
  );
});

test("tighten lowers counts and drops clean or missing files, and never raises or adds", async () => {
  const { hits } = await scanFixture();
  assert.deepEqual(
    tighten(
      { "src/old.ts": 5, "src/new.ts": 1, "src/clean.ts": 2, "src/gone.ts": 1 },
      hits.get("no-sleep"),
    ),
    { "src/old.ts": 2, "src/new.ts": 1 },
  );
  assert.deepEqual(tighten({ "src/old.ts": 1 }, hits.get("no-sleep")), { "src/old.ts": 1 });
});

test("baselines are written with sorted keys, one entry per line", () => {
  assert.equal(formatBaseline({ "b.ts": 1, "a/c.ts": 2 }), '{\n  "a/c.ts": 2,\n  "b.ts": 1\n}\n');
});
