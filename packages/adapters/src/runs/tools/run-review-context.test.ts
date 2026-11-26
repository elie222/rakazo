import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "../assembly/run-context.js";
import { routinePromptsForReview } from "./run-review-context.js";

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

describe("routinePromptsForReview", () => {
  it("finds the managed bot's routine an update names, across its chats", async () => {
    await expect(
      routinePromptsForReview(reviewRun(), "schedule_update", {
        bot_id: "child",
        routineId: "child",
        prompt: "New",
      }),
    ).resolves.toEqual({ current: "Child prompt" });
  });

  it("keeps a group run's own update to the group's routines", async () => {
    await expect(
      routinePromptsForReview(reviewRun(), "schedule_update", { routineId: "own", prompt: "New" }),
    ).resolves.toEqual({});
  });

  it("applies edits before redacting, as the save does, when a find holds part of a secret", async () => {
    const ctx = reviewRun();
    (ctx as { secrets: string[] }).secrets = ["Child"];
    const edited = await routinePromptsForReview(ctx, "schedule_update", {
      bot_id: "child",
      routineId: "child",
      promptEdits: [{ find: "ild prompt", replace: "ild task" }],
    });
    expect(edited.current).not.toContain("Child");
    expect(edited.edited).toBe(edited.current?.replace("prompt", "task"));
  });
});
