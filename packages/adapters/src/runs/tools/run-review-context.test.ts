import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "../assembly/run-context.js";
import { currentRoutinePrompt } from "./run-review-context.js";

function reviewRun() {
  const routines = [
    { id: "own", botId: "b", threadId: "dm-thread", prompt: "Own prompt" },
    { id: "child", botId: "child", threadId: "child-thread", prompt: "Child prompt" },
  ];
  const findFirst = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const row = routines.find(
      (routine) =>
        routine.id === where.id &&
        routine.botId === where.botId &&
        (where.threadId === undefined || routine.threadId === where.threadId),
    );
    return row ? { prompt: row.prompt } : null;
  });
  return {
    deps: {
      prisma: {
        routine: { findFirst },
        bot: {
          findMany: async ({ where }: { where: { id?: string } }) =>
            where.id === "child" ? [{ id: "child", name: "Child", thread: null }] : [],
        },
      },
    },
    run: { spaceId: "s" },
    fleetRun: { spaceId: "s", userId: "u", botId: "b" },
    bot: { id: "b" },
    thread: { id: "group-thread", groupId: "group-1" },
    secrets: [],
  } as unknown as RunContext;
}

describe("currentRoutinePrompt", () => {
  it("finds the managed bot's routine an update names, across its chats", async () => {
    await expect(
      currentRoutinePrompt(reviewRun(), "schedule_update", {
        bot_id: "child",
        routineId: "child",
        prompt: "New",
      }),
    ).resolves.toBe("Child prompt");
  });

  it("keeps a group run's own update to the group's routines", async () => {
    await expect(
      currentRoutinePrompt(reviewRun(), "schedule_update", { routineId: "own", prompt: "New" }),
    ).resolves.toBeUndefined();
  });
});
