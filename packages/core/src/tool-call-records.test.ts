import { describe, expect, it } from "vitest";
import { foldToolCallRecords, reduceToolCallRecord } from "./tool-call-records.js";

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
        outcome: "succeeded",
        durationMs: 30_000,
        command: "pnpm test",
        output: "RUN v4\n1 failed",
        exitCode: 1,
      },
    ]);
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

  it("ignores malformed command events", () => {
    expect(
      foldToolCallRecords([{ type: "computer.command", payload: { executionId: "x" } }]),
    ).toEqual([]);
  });
});
