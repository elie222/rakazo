import { describe, expect, it, vi } from "vitest";
import { loadToolCallRecords } from "./tool-call-records.js";

describe("loadToolCallRecords", () => {
  it("reads calls in order and only the newest frame of each shell command", async () => {
    const findMany = vi.fn(async () => [
      { type: "agent.tool.called", seq: 1, payload: { name: "shell", executionId: "x1" } },
      {
        type: "agent.tool.completed",
        seq: 3,
        payload: { name: "shell", executionId: "x1", outcome: "succeeded", durationMs: 50 },
      },
    ]);
    const queryRaw = vi.fn(async (_query: { sql: string }) => [
      {
        type: "computer.command",
        seq: 4,
        payload: {
          executionId: "x1",
          kind: "shell",
          command: "ls",
          cwd: ".",
          status: "done",
          exitCode: 0,
          output: "a\nb",
        },
      },
    ]);
    const prisma = { event: { findMany }, $queryRaw: queryRaw } as never;

    await expect(loadToolCallRecords(prisma, "thread-1", "run-1")).resolves.toEqual([
      {
        executionId: "x1",
        name: "shell",
        status: "done",
        outcome: "succeeded",
        durationMs: 50,
        command: "ls",
        output: "a\nb",
        exitCode: 0,
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread-1",
          runId: "run-1",
          type: { in: ["agent.tool.called", "agent.tool.completed"] },
        },
        orderBy: { seq: "asc" },
      }),
    );
    const sql = queryRaw.mock.calls[0]?.[0].sql ?? "";
    expect(sql).toContain("DISTINCT ON");
    expect(sql).toContain("computer.command");
  });
});
