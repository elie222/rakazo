import { describe, expect, it } from "vitest";
import {
  createToolCallRecordStore,
  fencedCode,
  foldToolCallRecords,
  prettyToolText,
  reduceToolCallRecord,
  toolCallMarkdown,
} from "./tool-call-records.js";

describe("foldToolCallRecords", () => {
  it("gives one record per call with its outcome, duration and result text", () => {
    expect(
      foldToolCallRecords([
        {
          type: "agent.tool.completed",
          payload: {
            name: "web_search",
            executionId: "x1",
            outcome: "succeeded",
            durationMs: 812.4,
            preview: "Three results.",
          },
        },
        {
          type: "agent.tool.completed",
          payload: { name: "read_file", executionId: "x2", outcome: "error", error: "ENOENT" },
        },
        { type: "agent.tool.completed", payload: { name: "no-id" } },
      ]),
    ).toEqual([
      {
        executionId: "x1",
        name: "web_search",
        status: "done",
        outcome: "succeeded",
        durationMs: 812,
        output: "Three results.",
      },
      { executionId: "x2", name: "read_file", status: "done", outcome: "error", error: "ENOENT" },
    ]);
  });

  it("lets a shell command's own events say what it printed and when it finished", () => {
    const base = { executionId: "x1", kind: "shell", command: "pnpm test", cwd: "." };
    expect(
      foldToolCallRecords([
        {
          type: "computer.command",
          payload: { ...base, status: "running", exitCode: null, output: "RUN v4" },
        },
        {
          type: "agent.tool.completed",
          payload: {
            name: "shell",
            executionId: "x1",
            outcome: "succeeded",
            durationMs: 30_000,
            preview: "RUN v4 (still running)",
          },
        },
        {
          type: "computer.command",
          payload: { ...base, status: "done", exitCode: 1, output: "RUN v4\n1 failed" },
        },
        // A late running frame never reopens a finished command.
        {
          type: "computer.command",
          payload: { ...base, status: "running", exitCode: null, output: "stale" },
        },
      ]),
    ).toEqual([
      {
        executionId: "x1",
        name: "shell",
        status: "done",
        outcome: "error",
        durationMs: 30_000,
        command: "pnpm test",
        output: "RUN v4\n1 failed",
        exitCode: 1,
      },
    ]);
  });

  it("shows what a file action returned, since its command event prints nothing", () => {
    expect(
      foldToolCallRecords([
        {
          type: "computer.command",
          payload: {
            executionId: "x1",
            kind: "write_file",
            command: "/tmp/a.py",
            cwd: ".",
            status: "done",
            exitCode: 0,
            output: "",
          },
        },
        {
          type: "agent.tool.completed",
          payload: {
            name: "write_file",
            executionId: "x1",
            outcome: "succeeded",
            preview: "Wrote 12 bytes.",
          },
        },
      ]),
    ).toEqual([
      {
        executionId: "x1",
        name: "write_file",
        status: "done",
        outcome: "succeeded",
        exitCode: 0,
        output: "Wrote 12 bytes.",
      },
    ]);
  });

  it("drops a run's live records when it ends and keeps only the newest runs", () => {
    const store = createToolCallRecordStore();
    const called = (runId: string) => ({
      type: "agent.tool.called",
      runId,
      payload: { name: "shell", executionId: `${runId}-x` },
    });
    for (let i = 0; i < 10; i += 1) store.record(called(`run-${i}`));
    expect(store.get("run-0")).toBeUndefined();
    expect(store.get("run-9")?.get("run-9-x")?.name).toBe("shell");
    store.record({ type: "run.completed", runId: "run-9", payload: {} });
    expect(store.get("run-9")).toBeUndefined();
  });

  it("keeps a shell command running after its tool returned early", () => {
    const records = foldToolCallRecords([
      {
        type: "computer.command",
        payload: {
          executionId: "x1",
          kind: "shell",
          command: "sleep 90",
          cwd: ".",
          status: "running",
          exitCode: null,
          output: "",
        },
      },
      {
        type: "agent.tool.completed",
        payload: { name: "shell", executionId: "x1", outcome: "succeeded", durationMs: 20_000 },
      },
    ]);
    expect(records[0]).toMatchObject({
      status: "running",
      outcome: "succeeded",
      command: "sleep 90",
    });
  });

  it("reduces one event at a time for a live view", () => {
    const records = new Map();
    expect(reduceToolCallRecord(records, { type: "thread.progress", payload: {} })).toBeUndefined();
    const first = reduceToolCallRecord(records, {
      type: "agent.tool.completed",
      payload: { name: "shell", executionId: "x1", outcome: "succeeded", durationMs: 5 },
    });
    expect(first).toMatchObject({ executionId: "x1", status: "done", outcome: "succeeded" });
  });

  it("keeps a call's arguments from its call event until its result lands", () => {
    expect(
      foldToolCallRecords([
        {
          type: "agent.tool.called",
          payload: { name: "web_search", executionId: "x1", input: '{\n  "query": "weather"\n}' },
        },
        {
          type: "agent.tool.completed",
          payload: {
            name: "web_search",
            executionId: "x1",
            outcome: "succeeded",
            preview: "Sunny.",
          },
        },
      ]),
    ).toEqual([
      {
        executionId: "x1",
        name: "web_search",
        status: "done",
        outcome: "succeeded",
        input: '{\n  "query": "weather"\n}',
        output: "Sunny.",
      },
    ]);
    expect(foldToolCallRecords([{ type: "agent.tool.called", payload: { name: "x" } }])).toEqual(
      [],
    );
  });

  it("indents JSON output and leaves other text alone", () => {
    expect(prettyToolText('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(prettyToolText("[1,2]")).toBe("[\n  1,\n  2\n]");
    expect(prettyToolText("{not json")).toBe("{not json");
    expect(prettyToolText("plain text\n")).toBe("plain text\n");
  });

  it("draws a shell call as one console block and a structured call as its JSON", () => {
    expect(toolCallMarkdown({ command: "ls -la", output: "a\nb\n" })).toBe(
      "```console\n$ ls -la\na\nb\n```",
    );
    expect(toolCallMarkdown({ command: "sleep 9" })).toBe("```console\n$ sleep 9\n```");
    // A shell printed exactly this, so it is not reformatted even when it parses as JSON.
    expect(toolCallMarkdown({ command: "cat a.json", output: '{"a":1}' })).toBe(
      '```console\n$ cat a.json\n{"a":1}\n```',
    );
    expect(toolCallMarkdown({ input: '{"q":1}', output: '{"a":[1]}' })).toBe(
      '```json\n{"q":1}\n```\n\n```json\n{\n  "a": [\n    1\n  ]\n}\n```',
    );
    expect(toolCallMarkdown({ output: "Two results." })).toBe("```text\nTwo results.\n```");
    expect(toolCallMarkdown({})).toBe("");
  });

  it("outruns backticks inside the code with a longer fence", () => {
    expect(fencedCode("a ``` b", "text")).toBe("````text\na ``` b\n````");
  });

  it("ignores malformed command events", () => {
    expect(
      foldToolCallRecords([{ type: "computer.command", payload: { executionId: "x" } }]),
    ).toEqual([]);
  });

  it("builds a shell's record from its call and completion alone", () => {
    const called = {
      type: "agent.tool.called",
      payload: { name: "shell", executionId: "s1", command: "npm login" },
    };
    expect(
      foldToolCallRecords([
        called,
        {
          type: "agent.tool.completed",
          payload: {
            name: "shell",
            executionId: "s1",
            outcome: "succeeded",
            exitCode: 0,
            preview: "ok",
          },
        },
      ]),
    ).toEqual([
      {
        executionId: "s1",
        name: "shell",
        status: "done",
        outcome: "succeeded",
        command: "npm login",
        exitCode: 0,
        output: "ok",
      },
    ]);
    // Still running when its call returned: it stays running, and its own exit later wins.
    const [running] = foldToolCallRecords([
      called,
      {
        type: "agent.tool.completed",
        payload: { name: "shell", executionId: "s1", outcome: "succeeded", exitCode: null },
      },
    ]);
    expect(running).toMatchObject({ status: "running", exitCode: null });
    const [finished] = foldToolCallRecords([
      called,
      {
        type: "computer.command",
        payload: {
          executionId: "s1",
          kind: "shell",
          command: "npm login",
          cwd: ".",
          status: "done",
          exitCode: 1,
          output: "denied",
        },
      },
      {
        type: "agent.tool.completed",
        payload: { name: "shell", executionId: "s1", outcome: "error", exitCode: null },
      },
    ]);
    expect(finished).toMatchObject({ status: "done", exitCode: 1, output: "denied" });
  });
});
