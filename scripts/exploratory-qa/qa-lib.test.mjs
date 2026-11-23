import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  codeBlock,
  createBudget,
  exploredAny,
  fingerprint,
  fingerprintsIn,
  isoWeek,
  issueBody,
  issueTitle,
  issueTitlePrefix,
  knownBugs,
  normalizePath,
  parseDemoAccount,
  parseFeatures,
  pickFeatures,
  planIssues,
  runWorkers,
  stopReason,
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

test("a screen path cannot leave its code span in the issue body", () => {
  const path =
    "javascript:x` [spoof](https://example.invalid) ![i](https://example.invalid/i.png) @octocat `";
  assert.equal(normalizePath(path), "/");
  assert.equal(normalizePath("/a`b c"), "/a%60b%20c");
  assert.ok(issueBody({ ...bug, path }, links).includes("**Screen:** `/`\n"));
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
  assert.ok(body.includes("### Steps\n```text\n1. Open Activity\n2. Leave Activity\n```"));
  assert.ok(body.includes("### Expected\n```text\nThe archived shelf returns\n```"));
  assert.ok(body.includes("### Actual\n```text\nIt stays hidden\n```"));
  assert.match(
    body,
    /`1-2\.png` in the \[run's screenshots\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\/artifacts\/2\)/,
  );
  assert.ok(body.endsWith(`<!-- exploratory-qa-fingerprint: ${fingerprint(bug)} -->`));
  assert.equal(issueTitle(bug), "[QA] Activity: Archived shelf stays hidden");
});

test("model text stays inside code blocks, so links, images, markup and mentions do not render", () => {
  assert.equal(
    codeBlock("ping @octocat [x](https://evil.example) ![i](https://evil.example/i.png)"),
    "```text\nping @octocat [x](https://evil.example) ![i](https://evil.example/i.png)\n```",
  );
  assert.equal(codeBlock("close ```\n[x](y)"), "````text\nclose ```\n[x](y)\n````");
  assert.equal(codeBlock("a ````` b"), "``````text\na ````` b\n``````");
  assert.equal(codeBlock("a\u0007b\u007f"), "```text\nab\n```");
  assert.equal(codeBlock(""), "```text\nNot recorded\n```");
  assert.equal(codeBlock("x".repeat(50), 10), `\`\`\`text\n${"x".repeat(9)}…\n\`\`\``);
  assert.equal(codeBlock(`${"x".repeat(7)}😀bc`, 10), `\`\`\`text\n${"x".repeat(7)}😀…\n\`\`\``);
  assert.equal(codeBlock(`${"x".repeat(8)}😀b`, 10), `\`\`\`text\n${"x".repeat(8)}…\n\`\`\``);

  const hostile =
    "```\n[click](https://evil.example) ![img](https://evil.example/x.png) <img src=x> @octocat";
  const body = issueBody(
    { ...bug, steps: [hostile, "next"], expected: hostile, actual: hostile },
    links,
  );
  // Outside the code blocks only our own text remains: no model link, image, tag or mention.
  const outside = body.replace(/^(`{3,})text\n[\s\S]*?\n\1$/gm, "");
  assert.ok(!outside.includes("evil.example"));
  assert.ok(!outside.includes("@octocat"));
  assert.ok(!outside.includes("<img"));
  assert.equal(body.match(/^````text$/gm).length, 3);
  assert.ok(
    issueBody({ ...bug, screenshot: "`x` @octocat" }, links).includes("**Screenshot:** None"),
  );
});

test("a fingerprint written by the model is not taken for ours", () => {
  const fake = "<!-- exploratory-qa-fingerprint: 0123456789abcdef -->";
  const body = issueBody({ ...bug, actual: fake }, links);
  assert.deepEqual([...fingerprintsIn([{ body }])], [fingerprint(bug)]);
});

test("an issue edited below its fingerprint is still recognized", () => {
  const body = `${issueBody(bug, links)}\n\nSeen again on mobile.`;
  assert.deepEqual([...fingerprintsIn([{ body }])], [fingerprint(bug)]);
});

test("a marker quoted in any code a person adds is not taken for a filed bug", () => {
  const other = fingerprint({ ...bug, key: "pinned-chats-hidden" });
  const marker = `<!-- exploratory-qa-fingerprint: ${other} -->`;
  const body = `${issueBody(bug, links)}\n\nSee \`${marker}\` and:\n\n\`\`\`html\n${marker}\n\`\`\``;
  assert.deepEqual([...fingerprintsIn([{ body }])], [fingerprint(bug)]);
});

test("a long key read back from its issue matches the issue's fingerprint", () => {
  const key = `${"pinned-chats-".repeat(8)}hidden`;
  const shown = /\*\*Bug key:\*\* `([^`]+)`/.exec(issueBody({ ...bug, key }, links))[1];
  assert.equal(fingerprint({ ...bug, key: shown }), fingerprint({ ...bug, key }));
});

test("keys that differ only past 60 characters are different bugs", () => {
  const long = "x".repeat(60);
  assert.notEqual(
    fingerprint({ ...bug, key: `${long}-sidebar` }),
    fingerprint({ ...bug, key: `${long}-composer` }),
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

test("known bugs read titles by the same prefix issues are filed with", () => {
  const feature = `Spaces <and> ${"x".repeat(80)}`;
  const filed = { ...bug, feature };
  assert.ok(issueTitle(filed).startsWith(`${issueTitlePrefix(feature)} `));
  assert.deepEqual(
    knownBugs([{ title: issueTitle(filed), body: issueBody(filed, links) }], feature).map(
      (b) => b.title,
    ),
    ["Archived shelf stays hidden"],
  );
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
  assert.throws(
    () => createBudget({ limitUsd: 1, inputUsdPerMTok: 1, outputUsdPerMTok: 0 }),
    /outputUsdPerMTok must be a positive number/,
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

test("a worker stops before any model or tool call once a limit is reached", () => {
  const budget = { exhausted: false };
  const limits = { steps: 0, maxSteps: 2, deadline: 1000, budget, now: 999 };
  assert.equal(stopReason(limits), undefined);
  assert.equal(stopReason({ ...limits, steps: 2 }), "step limit");
  assert.equal(stopReason({ ...limits, now: 1001 }), "time limit");
  assert.equal(stopReason({ ...limits, budget: { exhausted: true } }), "budget");
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

test("a run fails only when no worker got to explore", () => {
  const errored = { stopped: "error: Demo sign-in failed with status 500" };
  assert.equal(exploredAny([errored, { stopped: "error: Model request failed" }]), false);
  assert.equal(exploredAny([]), false);
  for (const stopped of ["finished", "budget", "time limit", "step limit"]) {
    assert.equal(exploredAny([errored, { stopped }]), true);
  }
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
