import { describe, expect, it, vi } from "vitest";
import {
  loadToolCallRecords,
  settledToolCallRecord,
  withheldToolCallRecord,
} from "./tool-call-records.js";

/** Events of one type, as the client returns them opened. */
function eventTable(rows: Array<{ type: string; seq: number; payload: unknown }>) {
  return vi.fn(async ({ where }: { where: { type: string } }) =>
    rows.filter((row) => row.type === where.type),
  );
}

describe("loadToolCallRecords", () => {
  it("folds each call with its completion, a shell's command, output and exit included", async () => {
    const findMany = eventTable([
      {
        type: "agent.tool.called",
        seq: 1,
        payload: { name: "shell", executionId: "x1", command: "ls -la" },
      },
      {
        type: "agent.tool.completed",
        seq: 3,
        payload: {
          name: "shell",
          executionId: "x1",
          outcome: "error",
          durationMs: 50,
          exitCode: 2,
          preview: "ls: denied",
        },
      },
      // A completion for a call past the limit is left out with it.
      {
        type: "agent.tool.completed",
        seq: 9,
        payload: { name: "read_file", executionId: "x9", outcome: "succeeded" },
      },
    ]);
    const prisma = { event: { findMany } } as never;
    await expect(loadToolCallRecords(prisma, "thread-1", "run-1")).resolves.toEqual([
      {
        executionId: "x1",
        name: "shell",
        status: "done",
        outcome: "error",
        durationMs: 50,
        command: "ls -la",
        output: "ls: denied",
        exitCode: 2,
      },
    ]);
    expect(findMany).toHaveBeenCalledTimes(2);
    for (const [query] of findMany.mock.calls) {
      expect(query).toMatchObject({
        where: { threadId: "thread-1", runId: "run-1" },
        orderBy: { seq: "asc" },
      });
      expect((query as { take?: number }).take).toBeGreaterThan(0);
    }
  });

  it("reads nothing more for a run without calls", async () => {
    const prisma = { event: { findMany: eventTable([]) } } as never;
    await expect(loadToolCallRecords(prisma, "thread-1", "run-1")).resolves.toEqual([]);
  });

  it("settles a call a finished run left running", () => {
    const running = { executionId: "s1", name: "shell", status: "running" } as const;
    expect(settledToolCallRecord(running)).toEqual({ ...running, status: "done" });
    const done = { ...running, status: "done" } as const;
    expect(settledToolCallRecord(done)).toBe(done);
  });

  it("shows someone who did not start the run the call, not its arguments, result or error", () => {
    expect(
      withheldToolCallRecord({
        executionId: "x1",
        name: "read_history",
        status: "done",
        outcome: "error",
        input: '{"query":"private"}',
        output: "Private chat text",
        error: "No match for private",
      }),
    ).toEqual({
      executionId: "x1",
      name: "read_history",
      status: "done",
      outcome: "error",
      withheld: true,
    });
    // A shell's command and output are the computer's activity feed, which every reader sees.
    expect(
      withheldToolCallRecord({
        executionId: "s1",
        name: "shell",
        status: "done",
        command: "ls",
        output: "a",
        exitCode: 0,
      }),
    ).toEqual({
      executionId: "s1",
      name: "shell",
      status: "done",
      command: "ls",
      output: "a",
      exitCode: 0,
      withheld: true,
    });
  });
});

describe("withheldToolCallRecord for file actions", () => {
  it("drops what a file action returned, even with its exit code set", () => {
    expect(
      withheldToolCallRecord({
        executionId: "w1",
        name: "write_file",
        status: "done",
        exitCode: 0,
        output: '{"ok":true,"path":"/private/notes.md"}',
      }),
    ).toEqual({
      executionId: "w1",
      name: "write_file",
      status: "done",
      exitCode: 0,
      withheld: true,
    });
  });
});
