import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./pr-digest", import.meta.url));
const mockGh = String.raw`#!/usr/bin/env node
const { readFileSync, appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const print = (value) => console.log(typeof value === "string" ? value : JSON.stringify(value));
if (args[0] === "repo" && args[1] === "view") print("example/project");
else if (args[0] === "pr" && args[1] === "view") {
  if (args.includes("isCrossRepository")) print(fixture.fork ?? false);
  else if (args.includes("--jq")) print("abc");
  else print({ headRefOid: "abc", state: "OPEN", mergeable: "MERGEABLE", headRefName: "topic", reviewDecision: "" });
} else if (args[0] === "api") {
  const endpoint = args.find((arg) => arg === "graphql" || arg.startsWith("repos/"));
  if (endpoint === "graphql") print("viewer");
  else if (endpoint.endsWith("/replies")) {
    appendFileSync(process.env.CALLS, "POST\n");
    process.exit(1);
  } else if (endpoint.includes("/pulls/comments/")) print("1");
  else if (endpoint.includes("/check-runs?")) {
    // A sequence plays one entry per poll, then repeats its last entry.
    const polls = fixture.checks ?? [fixture.check ?? { name: "tests", status: "completed", conclusion: "success", html_url: "" }];
    appendFileSync(process.env.POLLS, "x");
    const count = readFileSync(process.env.POLLS, "utf8").length;
    const poll = polls[Math.min(count, polls.length) - 1];
    for (const run of Array.isArray(poll) ? poll : [poll]) print(run);
  }
  else if (endpoint.includes("/actions/jobs/")) {
    const result = require("node:child_process").spawnSync("jq", ["-r", args[args.indexOf("--jq") + 1]], {
      input: JSON.stringify({ steps: fixture.steps?.[endpoint.split("/").pop()] ?? [] }), encoding: "utf8"
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status);
  }
  else if (endpoint.includes("/status?")) {
    const polls = fixture.statuses ?? [[]];
    const count = readFileSync(process.env.POLLS, "utf8").length;
    for (const status of polls[Math.min(count, polls.length) - 1]) print(status);
  }
  else if (endpoint.includes("/issues/")) print(fixture.conversation ?? []);
  else if (endpoint.includes("/reviews?")) print(fixture.reviews ?? []);
  else if (endpoint.includes("/comments?")) print(fixture.inline ?? []);
  else process.exit(2);
} else process.exit(2);
`;

function comment({
  id = 12,
  body = "Please fix this",
  user = "reviewer",
  kind = "User",
  updated = "2026-01-01T00:00:00Z",
} = {}) {
  return {
    id,
    body,
    user: { login: user, type: kind },
    created_at: updated,
    updated_at: updated,
    html_url: `https://github.com/example/project/pull/1#issuecomment-${id}`,
  };
}

function runDigest(
  fixture: {
    conversation?: object[];
    inline?: object[];
    reviews?: object[];
    check?: object;
    checks?: object[];
    statuses?: object[][];
    fork?: boolean;
    steps?: Record<string, object[]>;
    deadline?: number;
  },
  ...args: string[]
) {
  const root = mkdtempSync(join(tmpdir(), "pr-digest-test-"));
  try {
    writeFileSync(join(root, "gh"), mockGh, { mode: 0o755 });
    writeFileSync(join(root, "fixture"), JSON.stringify(fixture));
    const callsPath = join(root, "calls");
    const result = spawnSync("bash", [script, ...(args.length ? args : ["1"])], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}${delimiter}${process.env.PATH}`,
        FIXTURE: join(root, "fixture"),
        CALLS: callsPath,
        POLLS: join(root, "polls"),
        PR_DIGEST_POLL: "1",
        // Longer than the spawn timeout, so a watch that fails to wake errors out.
        PR_DIGEST_DEADLINE: String(fixture.deadline ?? 60),
        PR_DIGEST_SEEN_DIR: join(root, "seen"),
      },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toContain("jq: error");
    return { ...result, calls: existsSync(callsPath) ? readFileSync(callsPath, "utf8") : "" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const reply = (id: number, body: string) =>
  comment({ id, body, user: "viewer", updated: "2026-01-02T00:00:00Z" });
const shown = (stdout: string, id: number) => stdout.includes(`[${id}] `);

describe("pr-digest", () => {
  it("does not infer whether tests ran from skipped steps after a failed step", () => {
    const names = ["Run pnpm test:integration", "Install dependencies"];
    const result = runDigest({
      checks: [
        names.map((_, index) => ({
          name: `Job ${index}`,
          status: "completed",
          conclusion: "failure",
          html_url: `https://github.com/example/project/actions/runs/1/job/${index + 2}`,
        })),
      ],
      steps: Object.fromEntries(
        names.map((name, index) => [
          index + 2,
          [
            { name, number: 1, conclusion: "failure" },
            { name: "Upload report", number: 2, conclusion: "skipped" },
          ],
        ]),
      ),
    });
    expect(result.status).toBe(10);
    for (const name of names) {
      expect(result.stdout).toContain(`step "${name}" failure (later steps skipped)`);
    }
    expect(result.stdout).not.toContain("tests did not run");
  });

  it("keeps conversation comments open until a later reply quotes the full permalink", () => {
    const url = (id: number) => comment({ id }).html_url;
    const replies: [number, string, boolean][] = [
      [21, url(21), false],
      [22, `[fixed](${url(22)})`, false],
      [23, `${url(23)}.`, false],
      [24, `${url(24)}3.`, true],
      [25, `${url(25)}3`, true],
      [26, "#issuecomment-26", true],
    ];
    const edited = comment({ id: 27, updated: "2026-01-03T00:00:00Z" });
    const actionable: [number, string, string, string][] = [
      [31, "reviewer", "User", "[vc]: Please fix this"],
      [32, "unknown[bot]", "Bot", "[vc]: Please fix this"],
      [33, "reviewer", "User", "<h3>Greptile Summary</h3>"],
      [34, "reviewer", "User", "<!-- greptile_summary -->"],
      [35, "coderabbitai[bot]", "Bot", "<!-- coderabbit-ai-generated:v1 -->\nPlease fix this"],
      [36, "reviewer", "User", "Fix \x1b]0;title\x07 this"],
      [37, "reviewer", "User", "/agentic_review"],
    ];
    const result = runDigest({
      conversation: [
        ...replies.map(([id]) => comment({ id })),
        ...replies.map(([id, body]) => reply(id + 100, body)),
        edited,
        reply(127, edited.html_url),
        comment({ id: 28 }),
        ...actionable.map(([id, user, kind, body]) => comment({ id, user, kind, body })),
      ],
      // An inline reply never closes a conversation comment.
      inline: [{ ...reply(128, "Already fixed"), in_reply_to_id: 19 }],
    });
    expect(result.status).toBe(11);
    for (const [id, , open] of replies) expect(shown(result.stdout, id)).toBe(open);
    for (const id of [27, 28, ...actionable.map(([id]) => id)]) {
      expect(shown(result.stdout, id)).toBe(true);
    }
    expect(result.stdout).toContain("(0 noise)");
    expect(result.stdout).not.toContain("\x1b");
    expect(result.stdout).not.toContain("\x07");
  });

  it("ignores status chrome only from the automation that posts it", () => {
    const result = runDigest({
      conversation: [
        comment({ id: 41, user: "vercel[bot]", kind: "Bot", body: "[vc]: generated deployment" }),
        comment({
          id: 42,
          user: "github-actions[bot]",
          kind: "Bot",
          body: "<!-- rakazo-playwright-screenshots -->\n### Playwright screenshots\n",
        }),
        comment({
          id: 43,
          user: "greptile-apps[bot]",
          kind: "Bot",
          body: "<!-- greptile_summary -->\n\n<h2>Summary</h2>",
        }),
        comment({
          id: 44,
          user: "coderabbitai[bot]",
          kind: "Bot",
          body: "<!-- coderabbit-ai-generated:v1 -->\n\n<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n",
        }),
        comment({
          id: 45,
          user: "qodo-code-review[bot]",
          kind: "Bot",
          body: "<h3>PR Summary by Qodo</h3>\n\nFixes the thing",
        }),
        comment({
          id: 46,
          user: "qodo-code-review[bot]",
          kind: "Bot",
          body: "\n<h3>Code Review by Qodo</h3>\n\n<br/>\n",
        }),
        comment({
          id: 47,
          user: "qodo-code-review[bot]",
          kind: "Bot",
          body: "<!-- qodo:billing-blocked -->\n\nQodo reviews are paused.",
        }),
        comment({
          id: 49,
          user: "qodo-free-for-open-source-projects[bot]",
          kind: "Bot",
          body: "\n<h3>Qodo is busy working</h3>\n\nCheck back in a few minutes.",
        }),
        comment({ id: 48, user: "github-actions[bot]", kind: "Bot", body: "/agentic_review" }),
        comment({
          id: 51,
          user: "qodo-free-for-open-source-projects[bot]",
          kind: "Bot",
          body: "[Code review](https://github.com/o/r/pull/1#issuecomment-1) by qodo was updated up to the latest commit https://github.com/o/r/commit/abc",
        }),
        comment({
          id: 50,
          user: "github-actions[bot]",
          kind: "Bot",
          body: "<!-- rakazo-preview -->\n**Preview:** https://example.fly.dev",
        }),
      ],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("(11 noise)");
  });

  describe("Qodo review comment", () => {
    const finding = (n: number, title: string, tags: string[], detail = `Details for ${n}.`) =>
      `<details>\n<summary>  ${n}.  ${title} ${tags.map((t) => `<code>${t}</code>`).join(" ")}</summary>\n\n<br/>\n\n> <details open>\n><summary>Description</summary>\n><br/>\n>\n><pre>\n>${detail}\n></pre>\n></details>\n\n<hr/>\n</details>\n`;
    const sticky = (current: string[], previous: string[] = [], id = 60) =>
      comment({
        id,
        user: "qodo-free-for-open-source-projects[bot]",
        kind: "Bot",
        body: [
          "<h3>Code Review by Qodo</h3>\n\n<code>🐞 Bugs (3)</code>\n",
          ...current,
          "<!-- https://github.com/example/project/commit/abc0000000000000000000000000000000000000 -->\n",
          ...(previous.length
            ? [
                "<details>\n<summary><strong>Previous reviews</strong></summary>\n",
                ...previous,
                "</details>",
              ]
            : []),
        ].join("\n"),
      });
    const bug = ["🐞 Bug", "≡ Correctness"];

    it("lists unresolved findings from the latest review and blocks on them", () => {
      const result = runDigest({
        conversation: [
          sticky(
            [
              finding(1, "Cache misses a key", [...bug, "⭐ New"], "<b><i>lookup</i></b> skips it"),
              finding(2, "Retry can loop", bug),
              finding(3, "<s>Fixed earlier</s>", ["✓ Resolved"]),
              finding(4, "<s>Code moved</s>", ["⊘ Outdated"]),
              finding(5, "Escape \x1b]0;title\x07here", ["🐞 Bug\x1b[31m"]),
              "<details>\n<summary>  6.  No description <code>🐞 Bug</code></summary>\n</details>\n",
            ],
            [finding(1, "Only in an older review", bug)],
          ),
          comment({
            id: 61,
            user: "qodo-free-for-open-source-projects[bot]",
            kind: "Bot",
            body: "<h3>PR Summary by Qodo</h3>\n\nAdds a cache",
          }),
        ],
      });
      expect(result.status).toBe(11);
      expect(result.stdout).toContain("qodo reviewed head · 4 open · 0 answered");
      expect(result.stdout).toContain(
        "(qodo 1):0\n  Cache misses a key [🐞 Bug, ≡ Correctness, new] lookup skips it",
      );
      expect(result.stdout).toContain("Retry can loop [🐞 Bug, ≡ Correctness] Details for 2.");
      for (const gone of [
        "Fixed earlier",
        "Code moved",
        "Only in an older review",
        "Adds a cache",
      ]) {
        expect(result.stdout).not.toContain(gone);
      }
      expect(result.stdout).toContain("(2 noise)");
      expect(result.stdout).toContain("Escape ]0;titlehere [🐞 Bug[31m]");
      expect(result.stdout).toContain("(qodo 6):0\n  No description [🐞 Bug] \n");
      expect(result.stdout).not.toContain("\x1b");
      expect(result.stdout).not.toContain("\x07");
    });

    it("stops blocking on a finding your reply quotes, even after Qodo edits the comment", () => {
      const current = sticky([
        finding(1, "Don&#x27;t drop the key", bug),
        finding(2, "Retry can loop", bug),
      ]);
      const edited = { ...current, updated_at: "2026-01-05T00:00:00Z" };
      const answer = reply(
        70,
        `Declined [Don't drop the key](${current.html_url}): the key is rebuilt on read.`,
      );
      const both = reply(71, `${current.html_url} don't drop the key, retry can loop: intended.`);
      const unlinked = reply(72, "Retry can loop is intended.");

      const partial = runDigest({ conversation: [edited, answer, unlinked] });
      expect(partial.status).toBe(11);
      expect(partial.stdout).toContain("1 open · 1 answered");
      expect(partial.stdout).toContain("answered (qodo 1) Don't drop the key");
      expect(partial.stdout).toContain("Retry can loop [");

      const done = runDigest({ conversation: [edited, both] });
      expect(done.status).toBe(0);
      expect(done.stdout).toContain("0 open · 2 answered");
    });

    it("says when Qodo has not reviewed the head yet", () => {
      const old = sticky([]);
      old.body = old.body.replace("abc0000", "def0000");
      const result = runDigest({ conversation: [old] });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("qodo reviewed def00000, not the head yet");
    });

    it("wakes the watch when an edit adds a finding", () => {
      const running = { name: "e2e", status: "in_progress", conclusion: null, html_url: "" };
      const result = runDigest(
        {
          check: running,
          conversation: [sticky([finding(1, "Retry can loop", [...bug, "⭐ New"])])],
        },
        "--watch",
        "1",
      );
      expect(result.status).toBe(11);
      expect(result.stdout).toContain("Retry can loop");
    });
  });

  it("only blocks effective change requests", () => {
    const cases: [string, string[], boolean][] = [
      ["approver", ["APPROVED"], false],
      ["commenter", ["COMMENTED"], false],
      ["requester", ["CHANGES_REQUESTED"], true],
      ["reapprover", ["CHANGES_REQUESTED", "APPROVED"], false],
      ["followup", ["CHANGES_REQUESTED", "COMMENTED"], true],
      ["dismissed", ["DISMISSED"], false],
    ];
    const reviews = cases.flatMap(([login, states], user) =>
      states.map((state, index) => ({
        id: user * 10 + index,
        state,
        body: "Review summary",
        submitted_at: `2026-01-0${index + 1}T00:00:00Z`,
        user: { login, type: "User" },
      })),
    );
    const result = runDigest({ reviews });
    expect(result.status).toBe(11);
    for (const [login, , blocks] of cases) {
      expect(result.stdout.includes(`] ${login} (review`)).toBe(blocks);
    }
  });

  it("requires a new reply after inline edits unless the bot confirmed the fix", () => {
    const thread = (id: number, root: object, replied: boolean) => [
      { ...root, id, path: "example.sh", line: 1, in_reply_to_id: null },
      ...(replied ? [{ ...reply(id + 100, "Fixed"), in_reply_to_id: id }] : []),
    ];
    const confirmed = {
      ...comment({ user: "coderabbitai[bot]", kind: "Bot" }),
      body: "Please fix this ✅ Confirmed as addressed",
      updated_at: "2026-01-03T00:00:00Z",
    };
    const result = runDigest({
      inline: [
        ...thread(51, comment({ updated: "2026-01-01T00:00:00Z" }), true),
        ...thread(52, comment({ updated: "2026-01-03T00:00:00Z" }), true),
        ...thread(53, confirmed, true),
        ...thread(54, confirmed, false),
      ],
    });
    expect(result.status).toBe(11);
    expect([51, 52, 53, 54].map((id) => shown(result.stdout, id))).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });

  it("does not retry failed replies", () => {
    const result = runDigest({}, "--reply", "12", "Fixed");
    expect(result.status).toBe(1);
    expect(result.calls).toBe("POST\n");
  });

  describe("--watch", () => {
    const running = { name: "e2e", status: "in_progress", conclusion: null, html_url: "" };
    const failed = { ...running, status: "completed", conclusion: "failure" };

    it("wakes for an unseen finding while checks are still running", () => {
      const result = runDigest({ check: running, conversation: [comment()] }, "--watch", "1");
      expect(result.status).toBe(11);
      expect(result.stdout).toContain("Please fix this");
    });
    it("wakes when a check fails while others are still running", () => {
      const result = runDigest({ checks: [running, [failed, running]] }, "--watch", "1");
      expect(result.status).toBe(10);
    });

    it("wakes when a commit status fails while checks are still running", () => {
      const result = runDigest(
        { check: running, statuses: [[], [{ context: "deploy", state: "failure" }]] },
        "--watch",
        "1",
      );
      expect(result.status).toBe(10);
    });

    const deployAuth = {
      context: "Vercel",
      state: "failure",
      description: "Authorization required to deploy.",
    };

    it("ignores the deploy authorization failure fork PRs always get", () => {
      const passed = { ...running, status: "completed", conclusion: "success" };
      const result = runDigest(
        { checks: [running, running, passed], statuses: [[], [deployAuth]], fork: true },
        "--watch",
        "1",
      );
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("STATUS Vercel");
    });

    it("still wakes for that failure on a same-repo PR", () => {
      const result = runDigest(
        { check: running, statuses: [[], [deployAuth]], fork: false },
        "--watch",
        "1",
      );
      expect(result.status).toBe(10);
    });

    it("keeps waiting on a failure that was already there", () => {
      const started = Date.now();
      const result = runDigest({ checks: [[failed, running]], deadline: 3 }, "--watch", "1");
      expect(result.status).toBe(10);
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
    });
  });
});
