import type * as Db from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  createThreadMessageInTransaction: vi.fn(),
  appendEventInTransaction: vi.fn(),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  ...db,
}));

import {
  deleteSpentRoutine,
  deleteStrandedEndedRoutines,
  routineEndError,
  routineEnded,
  routineEndInZone,
} from "./routine-end.js";

const now = new Date("2026-11-23T12:00:00.000Z");
const daily = {
  crons: ["0 9 * * *"],
  timezone: "UTC",
  watch: null,
  active: true,
  nextRunAt: new Date("2026-11-24T09:00:00.000Z"),
  lastRunAt: new Date("2026-11-23T09:00:00.000Z"),
};

beforeEach(() => vi.useFakeTimers({ now }));
afterEach(() => vi.useRealTimers());

describe("routineEnded", () => {
  const endsAt = new Date("2026-11-30T23:59:59.999Z");

  it("counts a routine as ended only while it is on with no run left", () => {
    expect(routineEnded({ ...daily, active: true, nextRunAt: null, endsAt })).toBe(true);
    expect(routineEnded({ ...daily, endsAt })).toBe(false);
    expect(routineEnded({ ...daily, active: true, nextRunAt: null, endsAt: null })).toBe(false);
  });

  it("never counts a paused routine as ended, so running it by hand keeps it", () => {
    expect(routineEnded({ ...daily, active: false, nextRunAt: null, endsAt })).toBe(false);
  });
});

describe("routineEndError", () => {
  const routine = { crons: ["0 9 * * *"], watch: null, nextRunAt: daily.nextRunAt, events: false };
  const both = { end: true, nextRun: true };

  it("accepts an end after the next run", () => {
    expect(routineEndError({ ...routine, endsAt: new Date("2026-11-30T00:00:00Z") }, both)).toBe(
      null,
    );
  });

  it.each([
    [{ crons: ["@once"] }, "A one-time routine ends once it runs."],
    [{ crons: [] }, "Only a repeating schedule or a watch can have an end date."],
    [
      { events: true },
      "A routine with webhook, Git, chat or email triggers can't have an end date.",
    ],
    [{ endsAt: new Date("2026-11-23T11:00:00Z") }, "The end date must be in the future."],
    [{ endsAt: new Date("2026-11-24T08:00:00Z") }, "The end date is before the next run."],
  ])("refuses %j", (patch, error) => {
    expect(
      routineEndError({ ...routine, endsAt: new Date("2026-11-30T00:00:00Z"), ...patch }, both),
    ).toBe(error);
  });

  it("refuses an end on a routine that no longer repeats even when the end is unchanged", () => {
    expect(
      routineEndError(
        { ...routine, crons: [], nextRunAt: null, endsAt: new Date("2026-11-30T00:00:00Z") },
        { end: false, nextRun: false },
      ),
    ).toBe("Only a repeating schedule or a watch can have an end date.");
  });

  it("lets a routine past its end be paused without touching the end", () => {
    expect(
      routineEndError(
        { ...routine, nextRunAt: null, endsAt: new Date("2026-11-22T00:00:00Z") },
        { end: false, nextRun: true },
      ),
    ).toBeNull();
  });
});

describe("deleteSpentRoutine", () => {
  function setup(row: Record<string, unknown>) {
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const notify = vi.fn(async () => undefined);
    const publishSpaceChange = vi.fn(async () => undefined);
    const deps = {
      prisma: {
        routine: { findUnique: vi.fn(async () => row), deleteMany },
        $transaction: async (run: (client: unknown) => Promise<unknown>) => run({}),
      },
      events: { notify, publishSpaceChange },
    } as unknown as Parameters<typeof deleteSpentRoutine>[0];
    return { deps, deleteMany, notify, publishSpaceChange };
  }
  const spent = {
    ...daily,
    id: "routine-1",
    botId: "bot-1",
    userId: "user-1",
    threadId: "thread-1",
    name: "Black Friday deals",
    active: true,
    nextRunAt: null,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    emailSenders: null,
  };
  const input = { spaceId: "space-1", routineId: "routine-1", userId: "user-1" };

  it("deletes a routine past its end and says in its chat that it ended", async () => {
    db.createThreadMessageInTransaction.mockResolvedValue({ id: "message-1" });
    db.appendEventInTransaction.mockResolvedValue({ seq: 3 });
    const endsAt = new Date("2026-11-23T23:59:59.999Z");
    const { deps, deleteMany, notify, publishSpaceChange } = setup({ ...spent, endsAt });

    await expect(deleteSpentRoutine(deps, input)).resolves.toBe(true);

    expect(deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "routine-1", userId: "user-1", endsAt, active: true }),
    });
    expect(publishSpaceChange).toHaveBeenCalledWith("space-1", "routines");
    expect(db.createThreadMessageInTransaction).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        threadId: "thread-1",
        blocks: [{ kind: "routine_event", change: "ended", name: "Black Friday deals" }],
      }),
    );
    expect(notify).toHaveBeenCalledWith("thread-1", 3);
  });

  it("keeps a paused routine, whatever is left before its end", async () => {
    const { deps, deleteMany } = setup({
      ...spent,
      active: false,
      endsAt: new Date("2026-11-23T23:59:59.999Z"),
    });
    await expect(deleteSpentRoutine(deps, input)).resolves.toBe(false);
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe("deleteStrandedEndedRoutines", () => {
  it("deletes an ended routine once none of its runs has been under way for an hour", async () => {
    const stranded = {
      ...daily,
      id: "routine-1",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: null,
      name: "Black Friday deals",
      nextRunAt: null,
      endsAt: new Date("2026-11-23T23:59:59.999Z"),
    };
    const findMany = vi.fn(async () => [stranded]);
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const deps = {
      prisma: {
        routine: { findMany, findUnique: vi.fn(async () => stranded), deleteMany },
        bot: { findUnique: vi.fn(async () => null) },
      },
      events: { notify: vi.fn(), publishSpaceChange: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof deleteStrandedEndedRoutines>[0];

    await deleteStrandedEndedRoutines(deps, now);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          active: true,
          nextRunAt: null,
          runs: {
            none: {
              OR: [
                { status: { in: expect.any(Array) } },
                { updatedAt: { gt: new Date("2026-11-23T11:00:00.000Z") } },
              ],
            },
          },
        }),
      }),
    );
    expect(deleteMany).toHaveBeenCalledOnce();
  });
});

describe("routineEndInZone", () => {
  it("keeps the end's local day and time when the routine moves zone", () => {
    const newYorkEnd = new Date("2026-12-01T04:59:59.999Z");
    expect(routineEndInZone(newYorkEnd, "America/New_York", "Asia/Tokyo")?.toISOString()).toBe(
      "2026-11-30T14:59:59.999Z",
    );
    expect(routineEndInZone(null, "America/New_York", "Asia/Tokyo")).toBeNull();
  });
});
