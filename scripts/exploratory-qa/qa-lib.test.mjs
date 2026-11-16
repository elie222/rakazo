import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createBudget,
  fingerprint,
  isoWeek,
  issueBody,
  issueTitle,
  knownBugs,
  normalizePath,
  parseDemoAccount,
  parseFeatures,
  pickFeatures,
  planIssues,
  runWorkers,
  sanitize,
} from "./qa-lib.mjs";

const bug = {
  feature: "Activity",
  title: "Archived shelf stays hidden",
  key: "archived-shelf-hidden",
  path: "/chats/clx1a2b3c4d5e6f7g8h9i0j1k",
  steps: ["Open Activity", "Leave Activity"],
  expected: "The archived shelf returns",
  actual: "It stays hidden",
  screenshot: "1-2.png",
};
const links = {
  runUrl: "https://github.com/o/r/actions/runs/1",
  artifactUrl: "https://github.com/o/r/actions/runs/1/artifacts/2",
};

test("features come from PRODUCT.md sections a browser can explore", () => {
  const features = parseFeatures(
    readFileSync(new URL("../../PRODUCT.md", import.meta.url), "utf8"),
  );
  const names = features.map((f) => f.name);
  assert.ok(names.includes("Conversation"));
  assert.ok(!names.includes("Status and use"));
  assert.ok(features.every((f) => f.brief.length > 0 && !f.brief.includes("\n## ")));
});

test("the weekly rotation moves on and named features win", () => {
  const features = ["A", "B", "C", "D", "E"].map((name) => ({ name, brief: name }));
  const names = (week) => pickFeatures(features, { count: 2, week }).map((f) => f.name);
  assert.deepEqual(names(0), ["A", "B"]);
  assert.deepEqual(names(1), ["C", "D"]);
  assert.deepEqual(names(2), ["E", "A"]);
  assert.deepEqual(
    pickFeatures(features, { count: 2, week: 0, names: ["d"] }).map((f) => f.name),
    ["D"],
  );
  assert.throws(
    () => pickFeatures(features, { count: 2, week: 0, names: ["Z"] }),
    /Unknown features: Z/,
  );
  assert.equal(isoWeek(new Date("2026-01-01T12:00:00Z")), 1);
});

test("the fingerprint ignores record ids and wording but not the bug", () => {
  assert.equal(normalizePath("/chats/clx1a2b3c4d5e6f7g8h9i0j1k?tab=1"), "/chats/:id");
  assert.equal(normalizePath("/bots/42/"), "/bots/:id");
  const same = {
    ...bug,
    title: "Shelf missing",
    path: "/chats/clz9y8x7w6v5u4t3s2r1q0p9o",
    key: "Archived Shelf Hidden",
  };
  assert.equal(fingerprint(same), fingerprint(bug));
  assert.notEqual(fingerprint({ ...bug, key: "pinned-chats-hidden" }), fingerprint(bug));
  assert.notEqual(fingerprint({ ...bug, path: "/settings" }), fingerprint(bug));
  assert.match(fingerprint(bug), /^[0-9a-f]{16}$/);
});

test("the issue carries steps, expected, actual, the screenshot link and the fingerprint", () => {
  const body = issueBody(bug, links);
  assert.match(body, /1\. Open Activity\n2\. Leave Activity/);
  assert.match(body, /### Expected\nThe archived shelf returns/);
  assert.match(body, /### Actual\nIt stays hidden/);
  assert.match(
    body,
    /`1-2\.png` in the \[run's screenshots\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\/artifacts\/2\)/,
  );
  assert.ok(body.includes(`<!-- exploratory-qa-fingerprint: ${fingerprint(bug)} -->`));
  assert.equal(issueTitle(bug), "[QA] Activity: Archived shelf stays hidden");
});

test("model text cannot mention people, hide markup or run long", () => {
  assert.equal(sanitize("ping @octocat"), "ping `@octocat`");
  assert.equal(
    sanitize("a <!-- hidden --!> b <img src=x>"),
    "a &lt;!-- hidden --!&gt; b &lt;img src=x&gt;",
  );
  assert.equal(sanitize("Tom & `code`"), "Tom &amp; 'code'");
  assert.equal(sanitize("a\u0007b\u007f"), "ab");
  assert.equal(sanitize("x".repeat(50), 10).length, 10);
  const body = issueBody(
    { ...bug, actual: "<!-- exploratory-qa-fingerprint: 0123456789abcdef -->" },
    links,
  );
  assert.equal(body.match(/<!-- exploratory-qa-fingerprint/g).length, 1);
  assert.equal(
    issueTitle({ ...bug, title: "Saving <b>fails</b>" }),
    "[QA] Activity: Saving <b>fails</b>",
  );
  assert.ok(
    issueBody({ ...bug, screenshot: "`x` @octocat" }, links).includes("**Screenshot:** None"),
  );
});

test("one issue per bug: open issues and repeats are skipped, and the run is capped", () => {
  const open = [{ title: "x", body: issueBody(bug, links) }];
  const other = { ...bug, key: "pinned-chats-hidden" };
  assert.deepEqual(planIssues([bug, other, { ...other, title: "again" }], open), [other]);
  const many = Array.from({ length: 20 }, (_, i) => ({ ...bug, key: `bug-${i}` }));
  assert.equal(planIssues(many, [], 10).length, 10);
  assert.deepEqual(planIssues([{ title: "no fields" }, null, "text"], []), []);
  assert.deepEqual(planIssues({ not: "a list" }, []), []);
});

test("known bugs are read back from open issues for the matching feature", () => {
  const issues = [
    { title: issueTitle(bug), body: issueBody(bug, links) },
    { title: "[QA] Memory: Something", body: issueBody({ ...bug, feature: "Memory" }, links) },
  ];
  assert.deepEqual(knownBugs(issues, "Activity"), [
    { title: "Archived shelf stays hidden", key: "archived-shelf-hidden", screen: "/chats/:id" },
  ]);
});

test("the budget prices token usage and stops once reached", () => {
  const budget = createBudget({ limitUsd: 1, inputUsdPerMTok: 2, outputUsdPerMTok: 10 });
  budget.charge({ prompt_tokens: 250_000, completion_tokens: 0 });
  assert.equal(budget.exhausted, false);
  budget.charge({ prompt_tokens: 0, completion_tokens: 50_000 });
  assert.equal(budget.spentUsd, 1);
  assert.equal(budget.exhausted, true);
  assert.throws(
    () => createBudget({ limitUsd: 100, inputUsdPerMTok: 1, outputUsdPerMTok: 1 }),
    /capped/,
  );
  assert.throws(
    () => createBudget({ limitUsd: 1, inputUsdPerMTok: Number.NaN, outputUsdPerMTok: 1 }),
    /inputUsdPerMTok/,
  );
});

test("a response without usable token usage stops the run", () => {
  for (const usage of [
    undefined,
    {},
    { prompt_tokens: 10 },
    { prompt_tokens: Number.NaN, completion_tokens: 1 },
    { prompt_tokens: Number.POSITIVE_INFINITY, completion_tokens: 1 },
    { prompt_tokens: -5, completion_tokens: 1 },
    { prompt_tokens: "10", completion_tokens: 1 },
  ]) {
    const budget = createBudget({ limitUsd: 1, inputUsdPerMTok: 2, outputUsdPerMTok: 10 });
    assert.throws(() => budget.charge(usage), /no usable token usage/);
    assert.equal(budget.exhausted, true);
    assert.equal(budget.spentUsd, 0);
  }
});

test("a worker that fails keeps the other workers' findings", async () => {
  const features = [{ name: "Activity" }, { name: "Memory" }];
  const results = await runWorkers(features, async (feature) => {
    if (feature.name === "Memory") throw new Error("Demo sign-in failed with status 500");
    return { feature: feature.name, findings: [bug], stopped: "finished", summary: "ok" };
  });
  assert.deepEqual(results[0].findings, [bug]);
  assert.deepEqual(results[1], {
    feature: "Memory",
    findings: [],
    stopped: "error: Demo sign-in failed with status 500",
    summary: "",
  });
});

test("the demo account comes from the file the preview stack reads", () => {
  const account = parseDemoAccount(
    readFileSync(new URL("../../infra/preview/demo-account.env", import.meta.url), "utf8"),
  );
  assert.ok(account.email.includes("@") && account.password.length >= 16);
  assert.ok(
    readFileSync(new URL("../../infra/preview/start.sh", import.meta.url), "utf8").includes(
      'source "$ROOT/infra/preview/demo-account.env"',
    ),
  );
  assert.throws(() => parseDemoAccount("OWNER_EMAIL=a@b.c"), /OWNER_PASSWORD/);
});
