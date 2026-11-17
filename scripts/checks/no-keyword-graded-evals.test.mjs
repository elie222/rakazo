import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadRules, report, scan, violations } from "./ratchets.mjs";

const rule = (await loadRules()).find((candidate) => candidate.name === "no-keyword-graded-evals");

const fixture = mkdtempSync(path.join(tmpdir(), "keyword-evals-"));
after(() => rmSync(fixture, { recursive: true }));

const graders = [
  'check("lease-filed", /ana ruiz/i.test(e.files["results/lease.txt"] ?? "")),',
  'check("ticket-reference", /ZD-?1842|ticket\\s+#?1842/i.test(reply)),',
  'expect: { bot: { instructions: "~bullet" } },',
  'pass: e.text.toLowerCase().includes("bullet points"),',
  "expect(reply).toContain('next step');",
  "pass: /(?:succeeded|failed)\\b/m.test(\n  reply,\n),",
  'pass: reply.includes("is filed"),',
  'pass: !finalReply.includes("can\'t"),',
  'pass: e.text.includes("bullet points."),',
  'check("next-step", /next step/i.test(slackReply(e))),',
  "pass: replyText.match(/order placed/i) !== null,",
  "expect(\n  reply,\n).toContain('a summary');",
  'const told = e.memory\n  .toLowerCase()\n  .includes("the user said");',
  "pass: /^.*bullet points.*$/i.test(reply),",
  "pass: /^[^.]*next step[\\s\\S]+$/.test(reply),",
  'pass: reply?.includes("next step"),',
  "pass: finalReply?.match(/order placed/i) !== null,",
  "pass: e.text?.search(/bullet points/) >= 0,",
  "pass: /next step/i?.test(reply),",
  'const told = e.memory\n  ?.toLowerCase()\n  ?.includes("the user said");',
  "pass: e.text.includes(`next step`),",
].join("\n");

const deterministic = [
  'check("invoice-reference", /INV-42/.test(file(e, "results/urgent.txt"))),',
  'check("foreign-code-absent", !/MARIGOLD|773/i.test(e.text + e.memory)),',
  'check("fresh-conversation-recall", /^french$/i.test(file(e, "results/language.txt"))),',
  '{ id: "verified-component", pass: e.text.includes("ledger-indexer") },',
  'check("code-removed", !e.memory.includes("3391")),',
  '/fairhaven/i.test(String(call.args.query)) && call.outcome === "read",',
  'expect: { bot: { name: "~scout" } },',
  "pass: posted.includes(owner),",
  'pass: replyText.includes("ZD-1842 filed"),',
  'expect(messageIds).toContain("msg_1"),',
  'expect: { bot: { instructions: null, description: "" } },',
  'pass: reply?.includes("ZD-1842"),',
].join("\n");

const sources = {
  "packages/testkit/src/evals/graders.ts": graders,
  "packages/testkit/src/evals/structured.ts": deterministic,
  "packages/testkit/src/flows/shopping.ts":
    'const ok = botText.some((text) => text.includes("order placed"));\n',
  "packages/testkit/src/evals/graders.test.ts": graders,
  "packages/core/src/format.ts": graders,
};
for (const [file, text] of Object.entries(sources)) {
  mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
  writeFileSync(path.join(fixture, file), text);
}
const found = scan([rule], Object.keys(sources), fixture).get(rule.name);

test("counts word matches on model prose in eval code, not in grader tests or product code", () => {
  assert.deepEqual(
    Object.fromEntries([...found].map(([file, hits]) => [file, hits.map((hit) => hit.line)])),
    {
      "packages/testkit/src/evals/graders.ts": [
        1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 16, 19, 20, 21, 22, 23, 24, 25, 28, 29,
      ],
      "packages/testkit/src/flows/shopping.ts": [1],
    },
  );
});

test("leaves identifiers, exact values, tool arguments and effects alone", () => {
  assert.equal(found.has("packages/testkit/src/evals/structured.ts"), false);
});

test("a new keyword grader fails with a message naming the judge", () => {
  const failure = report(rule, violations({}, found));
  assert.match(failure, /LLM judge/);
  assert.match(failure, /packages\/testkit\/src\/evals\/graders\.ts:1/);
});
