import { beforeEach, describe, expect, it, vi } from "vitest";

const notice = vi.hoisted(() => ({ postRoutineNotice: vi.fn(async () => true) }));
vi.mock("../routines/routine-notice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../routines/routine-notice.js")>()),
  ...notice,
}));

import {
  cancelScheduleFromTool,
  createScheduleFromTool,
  updateScheduleFromTool,
} from "./schedule-tools.js";

beforeEach(() => vi.clearAllMocks());

function jobs() {
  return { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) };
}

describe("routine rows from the schedule tools", () => {
  it("create leaves a created row with the name only", async () => {
    const client = {
      bot: { findFirst: vi.fn(async () => ({ computer: null })) },
      routine: {
        findMany: async () => [],
        create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
          id: "routine-1",
          ...args.data,
        })),
      },
      $queryRaw: async () => [{ timezone: null }],
    };
    const prisma = {
      ...client,
      $transaction: async (run: (c: unknown) => Promise<unknown>) => run(client),
    };
    const append = vi.fn(async () => undefined);
    await createScheduleFromTool(
      { prisma, events: { append }, jobs: jobs() } as unknown as Parameters<
        typeof createScheduleFromTool
      >[0],
      {
        spaceId: "ws",
        botId: "bot",
        userId: "u",
        threadId: "thread",
        name: "Morning joke",
        prompt: "SECRET PROMPT TEXT",
        schedule: { every: 1, unit: "minutes" },
      },
    );
    expect(notice.postRoutineNotice).toHaveBeenCalledTimes(1);
    expect(notice.postRoutineNotice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        change: "created",
        name: "Morning joke",
        threadId: "thread",
        botId: "bot",
      }),
    );
    expect(JSON.stringify(notice.postRoutineNotice.mock.calls)).not.toContain("SECRET PROMPT");
  });

  it("update reads a pause as disabled and a rename as updated", async () => {
    const existing = {
      id: "routine-1",
      name: "Groceries",
      prompt: "p",
      active: true,
      crons: ["0 10 * * 1"],
      timezone: "UTC",
      nextRunAt: new Date("2030-01-01T10:00:00Z"),
      userId: "u",
      threadId: "thread",
      watch: null,
    };
    const deps = {
      prisma: {
        routine: {
          findFirst: vi.fn(async () => existing),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
      },
      events: { append: vi.fn(async () => undefined) },
      jobs: jobs(),
    } as unknown as Parameters<typeof updateScheduleFromTool>[0];
    const base = {
      spaceId: "ws",
      botId: "bot",
      userId: "u",
      threadId: "thread",
      routineId: "routine-1",
      schedule: {},
    };
    await updateScheduleFromTool(deps, { ...base, active: false });
    expect(notice.postRoutineNotice).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ change: "disabled", name: "Groceries" }),
    );
    await updateScheduleFromTool(deps, { ...base, name: "Shopping" });
    expect(notice.postRoutineNotice).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ change: "updated", name: "Shopping" }),
    );
    notice.postRoutineNotice.mockClear();
    await updateScheduleFromTool(deps, { ...base, active: true, name: "Groceries" });
    expect(notice.postRoutineNotice).not.toHaveBeenCalled();
  });

  it("cancel leaves a deleted row in the routine's chat", async () => {
    const deps = {
      prisma: {
        routine: {
          findFirst: vi.fn(async () => ({ id: "routine-1", name: "Daily", threadId: "thread" })),
          deleteMany: vi.fn(async () => ({ count: 1 })),
        },
      },
      events: { append: vi.fn() },
      jobs: jobs(),
    } as unknown as Parameters<typeof cancelScheduleFromTool>[0];
    await cancelScheduleFromTool(deps, { spaceId: "ws", botId: "bot", name: "Daily" });
    expect(notice.postRoutineNotice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ change: "deleted", name: "Daily", threadId: "thread" }),
    );
  });

  it("cancel of a routine that is not found leaves no row", async () => {
    const deps = {
      prisma: { routine: { findFirst: vi.fn(async () => null), deleteMany: vi.fn() } },
      events: { append: vi.fn() },
      jobs: jobs(),
    } as unknown as Parameters<typeof cancelScheduleFromTool>[0];
    await cancelScheduleFromTool(deps, { spaceId: "ws", botId: "bot", name: "Nope" });
    expect(notice.postRoutineNotice).not.toHaveBeenCalled();
  });
});
