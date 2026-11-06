import { describe, expect, it, vi } from "vitest";
import { loadToolCallRecords } from "./tool-call-records.js";

describe("loadToolCallRecords", () => {
  it("reads whole calls in order and only the newest frame of each shell command", async () => {
    const findMany = vi.fn(async () => [
      { type: "agent.tool.called", seq: 1, payload: { name: "shell", executionId: "x1" } },
    ]);
    const queryRaw = vi.fn(async (query: { sql: string; values: unknown[] }) =>
      query.sql.includes("computer.command")
        ? [
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
          ]
        : [
            {
              type: "agent.tool.completed",
              seq: 3,
              payload: { name: "shell", executionId: "x1", outcome: "succeeded", durationMs: 50 },
            },
          ],
    );
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
    // Calls are the bounded set; their completions and commands are read for exactly them.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: "thread-1", runId: "run-1", type: "agent.tool.called" },
        orderBy: { seq: "asc" },
        take: 2000,
      }),
    );
    const queries = queryRaw.mock.calls.map((call) => call[0]);
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.sql).toContain("= ANY(");
      expect(query.sql).toContain("LIMIT");
      expect(query.values).toContainEqual(["x1"]);
    }
    const commandSql = queries.find((query) => query.sql.includes("computer.command"))?.sql ?? "";
    expect(commandSql).toContain("DISTINCT ON");
    // The final frame wins over a streamed frame that landed after it.
    expect(commandSql).toContain("(payload->>'status' = 'done') DESC, seq DESC");
  });

  it("reads nothing more for a run without calls", async () => {
    const findMany = vi.fn(async () => []);
    const queryRaw = vi.fn(async () => []);
    const prisma = { event: { findMany }, $queryRaw: queryRaw } as never;
    await expect(loadToolCallRecords(prisma, "thread-1", "run-1")).resolves.toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
