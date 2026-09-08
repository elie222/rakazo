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
  if (args.includes("--jq")) print("abc");
  else print({ headRefOid: "abc", state: "OPEN", mergeable: "MERGEABLE", headRefName: "topic", reviewDecision: "" });
} else if (args[0] === "api") {
  const endpoint = args.find((arg) => arg === "graphql" || arg.startsWith("repos/"));
  if (endpoint === "graphql") print("viewer");
  else if (endpoint.endsWith("/replies")) {
    appendFileSync(process.env.CALLS, "POST\n");
    process.exit(1);
  } else if (endpoint.includes("/pulls/comments/")) print("1");
  else if (endpoint.includes("/check-runs?")) print({ name: "tests", status: "completed", conclusion: "success", html_url: "" });
  else if (endpoint.includes("/status?")) {}
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
  fixture: { conversation?: object[]; inline?: object[]; reviews?: object[] },
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

const original = comment();
const reply = (body: string) =>
  comment({ id: 13, body, user: "viewer", updated: "2026-01-02T00:00:00Z" });

describe("pr-digest", () => {
  it.each([
    [original.html_url, 0],
    [`[fixed](${original.html_url})`, 0],
    [`${original.html_url}.`, 0],
    [`${original.html_url}3.`, 11],
    [`${original.html_url}3`, 11],
    ["#issuecomment-12", 11],
  ])("matches complete permalinks: %s", (body, expected) => {
    expect(runDigest({ conversation: [original, reply(body)] }).status).toBe(expected);
  });

  it("reopens edited conversation comments", () => {
    const edited = comment({ updated: "2026-01-03T00:00:00Z" });
    expect(runDigest({ conversation: [edited, reply(edited.html_url)] }).status).toBe(11);
  });

  it.each([
    ["reviewer", "User", "[vc]: Please fix this", 11],
    ["unknown[bot]", "Bot", "[vc]: Please fix this", 11],
    ["vercel[bot]", "Bot", "[vc]: generated deployment", 0],
    [
      "github-actions[bot]",
      "Bot",
      "<!-- rakazo-playwright-screenshots -->\n### Playwright screenshots\n",
      0,
    ],
    ["reviewer", "User", "<h3>Greptile Summary</h3>", 11],
  ])("requires matching automation for noise: %s %s %s", (user, kind, body, expected) => {
    expect(runDigest({ conversation: [comment({ body, user, kind })] }).status).toBe(expected);
  });

  it.each([
    { states: ["APPROVED"], expected: 0 },
    { states: ["COMMENTED"], expected: 0 },
    { states: ["CHANGES_REQUESTED"], expected: 11 },
    { states: ["CHANGES_REQUESTED", "APPROVED"], expected: 0 },
    { states: ["CHANGES_REQUESTED", "COMMENTED"], expected: 11 },
    { states: ["DISMISSED"], expected: 0 },
  ])("only blocks effective change requests: $states", ({ states, expected }) => {
    const reviews = states.map((state, id) => ({
      id,
      state,
      body: "Review summary",
      submitted_at: `2026-01-0${id + 1}T00:00:00Z`,
      user: { login: "reviewer", type: "User" },
    }));
    expect(runDigest({ reviews }).status).toBe(expected);
  });

  it("does not let an inline reply close a conversation", () => {
    const inline = { ...reply("Already fixed"), in_reply_to_id: 19 };
    expect(runDigest({ conversation: [original], inline: [inline] }).status).toBe(11);
  });

  it.each([
    ["2026-01-01T00:00:00Z", 0],
    ["2026-01-03T00:00:00Z", 11],
  ])("requires a new reply after inline edits: %s", (updated, expected) => {
    const root = { ...comment({ updated }), path: "example.sh", line: 1, in_reply_to_id: null };
    const response = { ...reply("Fixed"), in_reply_to_id: root.id };
    expect(runDigest({ inline: [root, response] }).status).toBe(expected);
  });

  it("removes terminal controls", () => {
    const result = runDigest({ conversation: [comment({ body: "Fix \x1b]0;title\x07 this" })] });
    expect(result.status).toBe(11);
    expect(result.stdout).not.toContain("\x1b");
    expect(result.stdout).not.toContain("\x07");
  });

  it("does not retry failed replies", () => {
    const result = runDigest({}, "--reply", "12", "Fixed");
    expect(result.status).toBe(1);
    expect(result.calls).toBe("POST\n");
  });
});
