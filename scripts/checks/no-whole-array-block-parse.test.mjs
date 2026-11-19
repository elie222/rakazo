import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadRules, report, scan, violations } from "./ratchets.mjs";

const rule = (await loadRules()).find(
  (candidate) => candidate.name === "no-whole-array-block-parse",
);

const fixture = mkdtempSync(path.join(tmpdir(), "whole-array-blocks-"));
after(() => rmSync(fixture, { recursive: true }));

const sources = {
  "packages/db/src/threads/reader.ts": [
    "const parsed = MessageBlockSchema.array().safeParse(message.blocks);",
    "const { blocks, intact } = readMessageBlocks(message);",
    "const one = MessageBlockSchema.safeParse(block);",
  ].join("\n"),
  // The rest of the repository imports the schema under its exported name.
  "apps/api/src/threads/runs.ts": "const parsed = MessageBlock.array().safeParse(blocks);\n",
  "packages/adapters/src/bots/handoff.ts": [
    "const kept = storedMessageBlock.array().safeParse(blocks);",
    "const { blocks } = readMessageBlocks(message);",
  ].join("\n"),
  "packages/db/src/threads/reader.test.ts":
    "const parsed = MessageBlockSchema.array().safeParse(message.blocks);\n",
};
for (const [file, text] of Object.entries(sources)) {
  mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
  writeFileSync(path.join(fixture, file), text);
}
const found = scan([rule], Object.keys(sources), fixture).get(rule.name);

test("flags every name a whole-array parse uses, and never the entry-by-entry reader", () => {
  assert.deepEqual(
    Object.fromEntries([...found].map(([file, hits]) => [file, hits.map((hit) => hit.line)])),
    {
      "packages/db/src/threads/reader.ts": [1],
      "apps/api/src/threads/runs.ts": [1],
    },
  );
});

test("a new whole-array parse fails with a message naming the shared reader", () => {
  const failure = report(rule, violations({}, found));
  assert.match(failure, /readMessageBlocks/);
  assert.match(failure, /packages\/db\/src\/threads\/reader\.ts:1/);
});
