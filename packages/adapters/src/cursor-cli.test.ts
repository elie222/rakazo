import type { CommandRequest, ProcessEvent } from "@rakazo/adapter-kit";
import { toolRequiresApproval } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { resolveCloudAgentProvider } from "./cloud-agent-provider-env.js";
import { cursorCliBin, cursorCliEnabled, executeCursorCli } from "./cursor-cli.js";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";

const KEY = "cursor-secret-key";

function run(
  events: ProcessEvent[],
  seen: { request?: CommandRequest },
): (request: CommandRequest) => AsyncIterable<ProcessEvent> {
  return async function* (request) {
    seen.request = request;
    yield* events;
  };
}

const success = (result: string, sessionId = "sess-1"): ProcessEvent[] => [
  {
    type: "stdout",
    data: JSON.stringify({ type: "result", is_error: false, result, session_id: sessionId }),
  },
  { type: "exit", code: 0 },
];

describe("cursor CLI", () => {
  it("is on only with CURSOR_CLI=on and a key, and that does not enable cloud agents", () => {
    expect(cursorCliEnabled({})).toBe(false);
    expect(cursorCliEnabled({ CURSOR_CLI: "on" })).toBe(false);
    expect(cursorCliEnabled({ CURSOR_CLI: "true", CURSOR_API_KEY: KEY })).toBe(false);
    expect(cursorCliEnabled({ CURSOR_CLI: " ON ", CURSOR_API_KEY: ` ${KEY} ` })).toBe(true);
    expect(resolveCloudAgentProvider({ CURSOR_CLI: "on", CURSOR_API_KEY: KEY })).toBe("none");
    expect(cursorCliBin({})).toBe("agent");
    expect(cursorCliBin({ CURSOR_CLI_BIN: " agent.exe " })).toBe("agent.exe");
    expect(() =>
      cursorCliBin({ CURSOR_CLI: "on", CURSOR_API_KEY: KEY, CURSOR_CLI_BIN: "agent cli" }),
    ).toThrow("CURSOR_CLI_BIN must not contain spaces");
    expect(cursorCliBin({ CURSOR_CLI_BIN: "agent cli" })).toBe("agent cli");
  });

  it("passes the key only in env and returns the clipped result plus session id", async () => {
    const seen: { request?: CommandRequest } = {};
    const long = "x".repeat(TOOL_RESULT_TEXT_LIMIT + 5);
    const result = await executeCursorCli(run(success(long), seen), {
      prompt: " fix the tests ",
      model: "composer-2",
      resume: "sess-0",
      enabled: true,
      apiKey: ` ${KEY} `,
      bin: "agent",
      cwd: "bots/b1",
      secrets: [KEY],
    });
    expect(seen.request).toEqual({
      argv: [
        "agent",
        "-p",
        "--trust",
        "--force",
        "--output-format",
        "json",
        "--workspace",
        ".",
        "--model",
        "composer-2",
        "--resume",
        "sess-0",
        "--",
        "fix the tests",
      ],
      cwd: "bots/b1",
      env: { CURSOR_API_KEY: KEY },
      timeoutMs: expect.any(Number),
    });
    expect(seen.request?.argv.join(" ")).not.toContain(KEY);
    expect(seen.request?.argv).not.toContain("--api-key");
    expect(result).toEqual({
      result: `${"x".repeat(TOOL_RESULT_TEXT_LIMIT)}…`,
      sessionId: "sess-1",
    });
  });

  it("does not execute when the key, prompt, or model is unusable", async () => {
    const seen: { request?: CommandRequest } = {};
    const execute = run(success("ok"), seen);
    const base = {
      prompt: "task",
      enabled: true,
      apiKey: KEY,
      bin: "agent",
      cwd: undefined,
      secrets: [KEY],
    };
    expect(await executeCursorCli(execute, { ...base, enabled: false })).toEqual({
      error: "The coding CLI is not configured.",
    });
    expect(await executeCursorCli(execute, { ...base, apiKey: " " })).toEqual({
      error: "The coding CLI is not configured.",
    });
    expect(await executeCursorCli(execute, { ...base, prompt: " " })).toEqual({
      error: "prompt is required.",
    });
    expect(await executeCursorCli(execute, { ...base, model: "two words" })).toEqual({
      error: "model must be a single token.",
    });
    expect(seen.request).toBeUndefined();
  });

  it("places -- before the prompt so leading dashes are not parsed as flags", async () => {
    const seen: { request?: CommandRequest } = {};
    await executeCursorCli(run(success("ok"), seen), {
      prompt: "--help",
      enabled: true,
      apiKey: KEY,
      bin: "agent",
      cwd: undefined,
      secrets: [KEY],
    });
    expect(seen.request?.argv).toEqual([
      "agent",
      "-p",
      "--trust",
      "--force",
      "--output-format",
      "json",
      "--workspace",
      ".",
      "--",
      "--help",
    ]);
  });

  it("reports a failed run from redacted stderr, without the environment", async () => {
    const seen: { request?: CommandRequest } = {};
    const result = await executeCursorCli(
      run(
        [
          { type: "stdout", data: `not-json ${KEY}` },
          { type: "stderr", data: `failed ${KEY}\n` },
          { type: "exit", code: 1 },
        ],
        seen,
      ),
      {
        prompt: "task",
        enabled: true,
        apiKey: KEY,
        bin: "agent",
        cwd: undefined,
        secrets: [KEY],
      },
    );
    expect(result).toEqual({ error: "failed [redacted]" });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(seen.request?.env)).toContain(KEY);
  });

  it("says the CLI did not finish when the sandbox times the command out", async () => {
    const result = await executeCursorCli(
      async function* () {
        yield { type: "stderr", data: `command timed out after 5 ms\n${KEY}` };
        yield { type: "exit", code: 124 };
      },
      {
        prompt: "task",
        enabled: true,
        apiKey: KEY,
        bin: "agent",
        cwd: undefined,
        secrets: [KEY],
      },
    );
    expect(result).toEqual({ error: "The coding CLI did not finish." });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("redacts the trimmed key when the secret list only has the padded value", async () => {
    const padded = ` ${KEY} `;
    const call = {
      prompt: "task",
      enabled: true,
      apiKey: padded,
      bin: "agent",
      cwd: undefined,
      secrets: [padded],
    };
    const printed = await executeCursorCli(async function* () {
      yield* success(`done ${KEY}`);
    }, call);
    const thrown = await executeCursorCli(async function* () {
      yield { type: "stdout", data: "" };
      throw new Error(`boom ${KEY}`);
    }, call);
    expect(JSON.stringify(printed)).not.toContain(KEY);
    expect(printed).toEqual({ result: "done [redacted]", sessionId: "sess-1" });
    expect(JSON.stringify(thrown)).not.toContain(KEY);
    expect(thrown).toEqual({ error: "boom [redacted]" });
  });
});

describe("cursor_agent selection", () => {
  const names = (cursorCliEnabled: boolean, cloudAgentEnabled = false) =>
    selectBuiltinToolsForRun({
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
      cursorCliEnabled,
      cloudAgentEnabled,
    }).map((tool) => tool.name);

  it("is offered only when the CLI flag is on, even if cloud agents are off", () => {
    expect(names(false)).not.toContain("cursor_agent");
    expect(names(true, false)).toContain("cursor_agent");
    expect(names(true, false)).not.toContain("cloud_agent_launch");
    expect(toolRequiresApproval("cursor_agent", false)).toBe(true);
  });
});
