import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "../assembly/run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { taskTools } from "./run-tools-tasks.js";

type Row = {
  id: string;
  name: string;
  threadId: string | null;
  spaceId: string;
  botId: string;
  userId?: string;
};

/**
 * The bot's routines in its own chat, the group and none (made on the web), plus another member's
 * in the group, filtered like the database would.
 */
function groupRun() {
  const rows: Row[] = [
    { id: "routine-dm", name: "Daily check", threadId: "dm-thread", spaceId: "s", botId: "b" },
    { id: "routine-group", name: "Digest", threadId: "group-thread", spaceId: "s", botId: "b" },
    { id: "routine-web", name: "Weekly", threadId: null, spaceId: "s", botId: "b" },
    {
      id: "routine-peer",
      name: "Peer",
      threadId: "group-thread",
      spaceId: "s",
      botId: "other",
      userId: "u",
    },
    {
      id: "routine-colleague",
      name: "Colleague's",
      threadId: "other-thread",
      spaceId: "s",
      botId: "other",
      userId: "colleague",
    },
  ];
  const matches = (where: Record<string, unknown>) =>
    rows.filter((row) =>
      (["id", "name", "threadId", "spaceId", "botId"] as const).every(
        (key) => where[key] === undefined || where[key] === row[key],
      ),
    );
  const saved = (row: Row) => ({
    ...row,
    prompt: "p",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    inChat: false,
    nextRunAt: new Date("2100-01-01T09:00:00Z"),
    watch: null,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    emailSenders: null,
  });
  const findMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
    matches(where).map(saved),
  );
  const findFirst = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const row = matches(where)[0];
    return row ? saved(row) : null;
  });
  const count = vi.fn(
    async ({ where }: { where: Record<string, unknown> }) => matches(where).length,
  );
  const deleteMany = vi.fn(async () => ({ count: 1 }));
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const bots = [
    { id: "other", name: "Other", thread: { id: "other-thread" } },
    { id: "b", name: "Bot", thread: { id: "dm-thread" } },
  ];
  const findBots = vi.fn(
    async ({ where }: { where: { spaceId: string; id?: string; name?: string } }) =>
      bots.filter(
        (row) =>
          where.spaceId === "s" &&
          (where.id === undefined || where.id === row.id) &&
          (where.name === undefined || where.name === row.name),
      ),
  );
  const ctx = {
    deps: {
      prisma: {
        routine: { count, findMany, findFirst, deleteMany, updateMany },
        bot: { findMany: findBots },
        scratchpadItem: { findMany: vi.fn(async () => []) },
        taughtSkill: { findMany: vi.fn(async () => []) },
        agentSkill: { findMany: vi.fn(async () => []) },
      },
      jobs: { cancel: vi.fn(async () => undefined) },
      events: { append: vi.fn(async () => undefined) },
    },
    fleetRun: { spaceId: "s", userId: "u", botId: "b" },
    run: { id: "run-1", spaceId: "s", userId: "u", threadId: "group-thread" },
    bot: { id: "b", name: "Bot" },
    thread: { id: "group-thread", groupId: "group-1" },
    tools: { offered: [] },
  } as unknown as RunContext;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    ({ name, args, finish: async (result: unknown) => result }) as unknown as ToolCall;
  return { ctx, call, deleteMany, updateMany };
}

describe("routine tools in a group run", () => {
  it("lists the bot's routines from every chat and marks the group's own", async () => {
    const { ctx, call } = groupRun();
    const marks = [
      ["routine-dm", false],
      ["routine-group", true],
      ["routine-web", false],
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

describe("routine tools on a bot this bot manages", () => {
  it("lists all of that bot's routines, wherever they post", async () => {
    const { ctx, call } = groupRun();
    const listed = (await taskTools.schedule_list!(
      ctx,
      call("schedule_list", { bot_name: "Other" }),
    )) as { note?: string; routines: { routineId: string; inThisChat?: boolean }[] };
    expect(listed.note).toBeUndefined();
    expect(listed.routines.map((row) => [row.routineId, row.inThisChat])).toEqual([
      ["routine-peer", undefined],
      ["routine-colleague", undefined],
    ]);
  });

  it("changes and cancels its routines, but only its owner changes what one does", async () => {
    const { ctx, call, deleteMany, updateMany } = groupRun();
    await expect(
      taskTools.schedule_update!(
        ctx,
        call("schedule_update", { bot_id: "other", routineId: "routine-peer", prompt: "New" }),
      ),
    ).resolves.toMatchObject({ ok: true, routineId: "routine-peer" });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ spaceId: "s", botId: "other", id: "routine-peer" }),
        data: { prompt: "New" },
      }),
    );
    await expect(
      taskTools.schedule_update!(
        ctx,
        call("schedule_update", { bot_id: "other", routineId: "routine-colleague", prompt: "x" }),
      ),
    ).resolves.toEqual({
      error:
        "Only the person who owns this routine can change it. You can still pause or resume it with active, or make the user their own copy with schedule_create.",
    });
    await expect(
      taskTools.schedule_cancel!(
        ctx,
        call("schedule_cancel", { bot_id: "other", name: "Colleague's" }),
      ),
    ).resolves.toEqual({ ok: true, routineId: "routine-colleague", name: "Colleague's" });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { spaceId: "s", botId: "other", id: "routine-colleague" },
    });
  });

  it("finds no bot outside the space, and naming itself keeps a group run to the group", async () => {
    const { ctx, call, deleteMany } = groupRun();
    await expect(
      taskTools.schedule_cancel!(
        ctx,
        call("schedule_cancel", { bot_id: "elsewhere", routineId: "routine-peer" }),
      ),
    ).resolves.toEqual({ error: 'No bot with id "elsewhere". Call list_fleet for ids.' });
    await expect(
      taskTools.schedule_cancel!(
        ctx,
        call("schedule_cancel", { bot_id: "other", routineId: "routine-dm" }),
      ),
    ).resolves.toEqual({ error: "Schedule not found." });
    await expect(
      taskTools.schedule_cancel!(
        ctx,
        call("schedule_cancel", { bot_id: "b", routineId: "routine-dm" }),
      ),
    ).resolves.toEqual({
      error: "That routine is not this group chat's. Change it from the bot's own chat.",
    });
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
