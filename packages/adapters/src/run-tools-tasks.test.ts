import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { taskTools } from "./run-tools-tasks.js";

type Row = { id: string; name: string; threadId: string | null; spaceId: string; botId: string };

/**
 * The bot's routines in its own chat, the group and none (made on the web), plus another member's
 * in the group, filtered like the database would.
 */
function groupRun() {
  const rows: Row[] = [
    { id: "routine-dm", name: "Daily check", threadId: "dm-thread", spaceId: "s", botId: "b" },
    { id: "routine-group", name: "Digest", threadId: "group-thread", spaceId: "s", botId: "b" },
    { id: "routine-web", name: "Weekly", threadId: null, spaceId: "s", botId: "b" },
    { id: "routine-peer", name: "Peer", threadId: "group-thread", spaceId: "s", botId: "other" },
  ];
  const matches = (where: Record<string, unknown>) =>
    rows.filter((row) =>
      (["id", "name", "threadId", "spaceId", "botId"] as const).every(
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
  const ctx = {
    deps: {
      prisma: {
        routine: { findMany, findFirst, deleteMany, updateMany: vi.fn() },
        scratchpadItem: { findMany: vi.fn(async () => []) },
        taughtSkill: { findMany: vi.fn(async () => []) },
        agentSkill: { findMany: vi.fn(async () => []) },
      },
      jobs: { cancel: vi.fn(async () => undefined) },
    },
    run: { id: "run-1", spaceId: "s", userId: "u", threadId: "group-thread" },
    bot: { id: "b", name: "Bot" },
    thread: { id: "group-thread", groupId: "group-1" },
    tools: { offered: [] },
  } as unknown as RunContext;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    ({ name, args, finish: async (result: unknown) => result }) as unknown as ToolCall;
  return { ctx, call, deleteMany };
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

describe("routine tools in a run that follows an API key's instructions", () => {
  const keyRun = (existing?: { promptCredentialId: string | null }) => {
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "routine-new",
      ...args.data,
    }));
    const updateMany = vi.fn(async (_args: { data: Record<string, unknown> }) => ({ count: 1 }));
    const row = {
      id: "routine-1",
      name: "Daily",
      prompt: "old",
      threadId: "thread-1",
      spaceId: "s",
      botId: "b",
      userId: "u",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: true,
      watch: null,
      nextRunAt: new Date(Date.now() + 60_000),
      ...existing,
    };
    const ctx = {
      deps: {
        prisma: {
          routine: {
            create,
            updateMany,
            findMany: vi.fn(async () => []),
            findFirst: vi.fn(async () => row),
            findUnique: vi.fn(async () => row),
            findUniqueOrThrow: vi.fn(async () => row),
          },
        },
        events: { append: vi.fn(async () => undefined) },
        jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
      },
      run: {
        id: "run-1",
        spaceId: "s",
        userId: "u",
        threadId: "thread-1",
        promptCredentialId: "key-1",
      },
      bot: { id: "b", name: "Bot" },
      thread: { id: "thread-1", groupId: null },
      computer: { graphical: false },
      tools: { offered: [] },
    } as unknown as RunContext;
    const call = (name: string, args: Record<string, unknown>) =>
      ({ name, args, finish: async (result: unknown) => result }) as unknown as ToolCall;
    return { ctx, call, create, updateMany };
  };

  it("marks a routine schedule_create makes as the key's", async () => {
    const { ctx, call, create } = keyRun();
    await expect(
      taskTools.schedule_create!(
        ctx,
        call("schedule_create", {
          name: "Later",
          prompt: "Message the other space",
          timezone: "UTC",
          delaySeconds: 60,
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(create.mock.calls[0]![0].data).toMatchObject({
      prompt: "Message the other space",
      promptCredentialId: "key-1",
    });
  });

  it("marks a prompt schedule_update rewrites, and leaves a rename alone", async () => {
    const { ctx, call, updateMany } = keyRun({ promptCredentialId: null });
    await taskTools.schedule_update!(
      ctx,
      call("schedule_update", { routineId: "routine-1", name: "Renamed" }),
    );
    expect(updateMany.mock.calls.at(-1)![0].data).not.toHaveProperty("promptCredentialId");
    await taskTools.schedule_update!(
      ctx,
      call("schedule_update", { routineId: "routine-1", prompt: "Message the other space" }),
    );
    expect(updateMany.mock.calls.at(-1)![0].data).toMatchObject({
      prompt: "Message the other space",
      promptCredentialId: "key-1",
    });
  });

  it("does not clear a key's mark when a run of the person's own rewrites the prompt", async () => {
    const { ctx, call, updateMany } = keyRun({ promptCredentialId: "key-1" });
    (ctx.run as { promptCredentialId: string | null }).promptCredentialId = null;
    await taskTools.schedule_update!(
      ctx,
      call("schedule_update", { routineId: "routine-1", prompt: "Reworded by the bot" }),
    );
    expect(updateMany.mock.calls.at(-1)![0].data).not.toHaveProperty("promptCredentialId");
  });
});
