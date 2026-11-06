import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { taskTools } from "./run-tools-tasks.js";

type Row = {
  id: string;
  name: string;
  threadId: string | null;
  spaceId: string;
  botId: string;
  userId: string;
};

/**
 * The bot's routines in its own chat, the group and none (made on the web), plus another member's
 * in the group, filtered like the database would.
 */
function groupRun({ trigger = "user" }: { trigger?: string } = {}) {
  const rows: Row[] = [
    {
      id: "routine-dm",
      name: "Daily check",
      threadId: "dm-thread",
      spaceId: "s",
      botId: "b",
      userId: "u",
    },
    {
      id: "routine-group",
      name: "Digest",
      threadId: "group-thread",
      spaceId: "s",
      botId: "b",
      userId: "u",
    },
    {
      id: "routine-web",
      name: "Weekly",
      threadId: null,
      spaceId: "s",
      botId: "b",
      userId: "u",
    },
    {
      id: "routine-peer",
      name: "Peer",
      threadId: "group-thread",
      spaceId: "s",
      botId: "other",
      userId: "peer",
    },
    {
      id: "routine-other-user",
      name: "Other user",
      threadId: "group-thread",
      spaceId: "s",
      botId: "b",
      userId: "peer",
    },
  ];
  const matches = (where: Record<string, unknown>) =>
    rows.filter((row) =>
      (["id", "name", "threadId", "spaceId", "botId", "userId"] as const).every(
        (key) => where[key] === undefined || where[key] === row[key],
      ),
    );
  const findMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
    matches(where).map((row) => ({ ...row, prompt: "p", crons: ["0 9 * * *"], active: true })),
  );
  const findFirst = vi.fn(
    async ({ where }: { where: Record<string, unknown> }) => matches(where)[0] ?? null,
  );
  const deleteMany = vi.fn(async () => ({ count: 1 }));
  const updateMany = vi.fn();
  const ctx = {
    deps: {
      prisma: {
        routine: { findMany, findFirst, deleteMany, updateMany },
        scratchpadItem: { findMany: vi.fn(async () => []) },
        taughtSkill: { findMany: vi.fn(async () => []) },
        agentSkill: { findMany: vi.fn(async () => []) },
      },
      jobs: { cancel: vi.fn(async () => undefined) },
    },
    run: { id: "run-1", spaceId: "s", userId: "u", threadId: "group-thread", trigger },
    bot: { id: "b", name: "Bot" },
    thread: { id: "group-thread", groupId: "group-1" },
    tools: { offered: [] },
  } as unknown as RunContext;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    ({ name, args, finish: async (result: unknown) => result }) as unknown as ToolCall;
  return { ctx, call, deleteMany, updateMany };
}

describe("routine tools in a group run", () => {
  it("limits routine-triggered schedule listings to the run user", async () => {
    const { ctx, call, deleteMany, updateMany } = groupRun({ trigger: "routine" });
    const listed = (await taskTools.schedule_list!(ctx, call("schedule_list"))) as {
      routines: { routineId: string }[];
    };
    expect(listed.routines.map(({ routineId }) => routineId)).toEqual([
      "routine-dm",
      "routine-group",
      "routine-web",
    ]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("limits routine-triggered task catalog listings to the run user", async () => {
    const { ctx, call, deleteMany, updateMany } = groupRun({ trigger: "routine" });
    const catalog = (await taskTools.task_catalog!(ctx, call("task_catalog"))) as {
      routines: { routineId: string }[];
    };
    expect(catalog.routines.map(({ routineId }) => routineId)).toEqual([
      "routine-dm",
      "routine-group",
      "routine-web",
    ]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("limits routine-triggered schedule updates to the run user", async () => {
    const { ctx, call, updateMany } = groupRun({ trigger: "routine" });
    await expect(
      taskTools.schedule_update!(
        ctx,
        call("schedule_update", { routineId: "routine-other-user", name: "Changed" }),
      ),
    ).resolves.toEqual({ error: "Schedule not found." });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("limits routine-triggered schedule cancellations to the run user", async () => {
    const { ctx, call, deleteMany } = groupRun({ trigger: "routine" });
    await expect(
      taskTools.schedule_cancel!(ctx, call("schedule_cancel", { routineId: "routine-other-user" })),
    ).resolves.toEqual({ error: "Schedule not found." });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("lists the bot's routines from every chat and marks the group's own", async () => {
    const { ctx, call } = groupRun();
    const marks = [
      ["routine-dm", false],
      ["routine-group", true],
      ["routine-web", false],
      ["routine-other-user", true],
    ];
    const note =
      "inThisChat marks the routines this group chat can change; change the others from the bot's own chat.";
    const listed = (await taskTools.schedule_list!(ctx, call("schedule_list"))) as {
      note: string;
      routines: { routineId: string; inThisChat: boolean }[];
    };
    expect(listed.routines.map((row) => [row.routineId, row.inThisChat])).toEqual(marks);
    expect(listed.note).toBe(note);
    const catalog = (await taskTools.task_catalog!(ctx, call("task_catalog"))) as {
      routinesNote: string;
      routines: typeof listed.routines;
    };
    expect(catalog.routines.map((row) => [row.routineId, row.inThisChat])).toEqual(marks);
    expect(catalog.routinesNote).toBe(note);
  });

  it("refuses to change a listed routine from another chat, saying where it is", async () => {
    const { ctx, call, deleteMany } = groupRun();
    const error = {
      error: "That routine is not this group chat's. Change it from the bot's own chat.",
    };
    await expect(
      taskTools.schedule_update!(
        ctx,
        call("schedule_update", { routineId: "routine-dm", name: "x" }),
      ),
    ).resolves.toEqual(error);
    await expect(
      taskTools.schedule_cancel!(ctx, call("schedule_cancel", { name: "Daily check" })),
    ).resolves.toEqual(error);
    await expect(
      taskTools.schedule_cancel!(ctx, call("schedule_cancel", { routineId: "routine-web" })),
    ).resolves.toEqual(error);
    for (const routineId of ["made-up", "routine-peer"]) {
      await expect(
        taskTools.schedule_cancel!(ctx, call("schedule_cancel", { routineId })),
      ).resolves.toEqual({ error: "Schedule not found." });
      await expect(
        taskTools.schedule_update!(ctx, call("schedule_update", { routineId, name: "x" })),
      ).resolves.toEqual({ error: "Schedule not found." });
    }
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
