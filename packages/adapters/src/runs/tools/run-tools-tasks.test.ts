import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "../assembly/run-context.js";
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

describe("schedule_create with a command watch", () => {
  const watch = { kind: "command", command: "ls inbox", everyMinutes: 30 };

  /**
   * A run as `schedule_create` sees it. `tainted` is what the run has read or been sent, `resumed`
   * an attempt after a pause, and `approved` a call replayed from the owner's card.
   */
  function watchRun(options: {
    ownerStarted?: boolean;
    tainted?: boolean;
    resumed?: boolean;
    approved?: boolean;
  }) {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "r-new",
      ...data,
    }));
    const enqueue = vi.fn(async () => undefined);
    const client = {
      bot: { findFirst: vi.fn(async () => ({ id: "b", computer: null })) },
      user: { findUnique: vi.fn(async () => ({ timezone: "UTC" })) },
      routine: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []), create },
      $queryRaw: async () => [{ timezone: "UTC" }],
    };
    const ctx = {
      deps: {
        prisma: {
          ...client,
          $transaction: async (run: (c: unknown) => Promise<unknown>) => run(client),
        },
        events: { append: vi.fn(async () => undefined), publishSpaceChange: vi.fn() },
        jobs: { enqueue, cancel: vi.fn() },
      },
      run: { id: "run-1", spaceId: "s", userId: "u", threadId: "t" },
      runId: "run-1",
      bot: { id: "b", name: "Bot" },
      thread: { id: "t" },
      computer: { graphical: false },
      source: { ownerStartedRun: options.ownerStarted ?? true },
      state: {
        tainted: options.tainted ?? false,
        earlierAttempt: Promise.resolve(options.resumed ?? false),
      },
      trust: { receivedOutsideMessage: async () => false },
    } as unknown as RunContext;
    const call = {
      name: "schedule_create",
      args: { name: "Inbox", prompt: "report it", watch },
      nextApprovedTool: options.approved ? "schedule_create" : undefined,
      finish: async (result: unknown) => result,
    } as unknown as ToolCall;
    const run = async () => {
      await taskTools.schedule_create!(ctx, call);
      return create.mock.calls[0]![0].data as { active: boolean; nextRunAt: Date | null };
    };
    return { run, enqueue };
  }

  it.each([
    ["the owner's own untainted run", {}],
    ["an approved card in the owner's run", { approved: true }],
    // The resumed attempt after the owner answered the card reads as tainted; the card counts.
    ["an approved card in a resumed attempt", { approved: true, resumed: true }],
    ["an approved card after outside content", { approved: true, tainted: true }],
  ])("runs by itself from %s", async (_label, options) => {
    const { run, enqueue } = watchRun(options);
    expect(await run()).toMatchObject({ active: true, nextRunAt: expect.any(Date) });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it.each([
    ["outside content entered the run (Never ask draws no card)", { tainted: true }],
    ["a resumed attempt with no approved card", { resumed: true }],
    ["a run the owner did not start", { ownerStarted: false }],
    ["an approved card in a run the owner did not start", { ownerStarted: false, approved: true }],
  ])("is saved turned off from %s", async (_label, options) => {
    const { run, enqueue } = watchRun(options);
    expect(await run()).toMatchObject({ active: false, nextRunAt: null });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
