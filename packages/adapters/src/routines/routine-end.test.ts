import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  createThreadMessageInTransaction: vi.fn(),
  appendEventInTransaction: vi.fn(),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  ...db,
}));

import { deleteSpentRoutine, routineEndError, routineEnded } from "./routine-end.js";

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
  it("counts a routine as ended only once no run is left before its end", () => {
    const endsAt = new Date("2026-11-30T23:59:59.999Z");
    expect(routineEnded({ ...daily, endsAt })).toBe(false);
    expect(routineEnded({ ...daily, endsAt: null })).toBe(false);
    expect(routineEnded({ ...daily, active: false, nextRunAt: null, endsAt })).toBe(false);
    expect(
      routineEnded({
        ...daily,
        active: false,
        nextRunAt: null,
        endsAt: new Date("2026-11-24T08:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it("counts a watch's next check against its end", () => {
    const watch = { kind: "http", url: "https://example.com", everyMinutes: 60 };
    const stopped = { ...daily, crons: [], watch, active: false, nextRunAt: null };
    expect(routineEnded({ ...stopped, endsAt: new Date("2026-11-23T12:30:00.000Z") })).toBe(true);
    expect(routineEnded({ ...stopped, endsAt: new Date("2026-11-23T13:30:00.000Z") })).toBe(false);
  });
});

describe("routineEndError", () => {
  const routine = { crons: ["0 9 * * *"], watch: null, nextRunAt: daily.nextRunAt };

  it("accepts an end after the next run", () => {
    expect(routineEndError({ ...routine, endsAt: new Date("2026-11-30T00:00:00Z") })).toBeNull();
  });

  it.each([
    [{ crons: ["@once"] }, "A one-time routine ends once it runs."],
    [{ crons: [] }, "Only a repeating schedule or a watch can have an end date."],
    [{ endsAt: new Date("2026-11-23T11:00:00Z") }, "The end date must be in the future."],
    [{ endsAt: new Date("2026-11-24T08:00:00Z") }, "The end date is before the next run."],
  ])("refuses %j", (patch, error) => {
    expect(
      routineEndError({ ...routine, endsAt: new Date("2026-11-30T00:00:00Z"), ...patch }),
    ).toBe(error);
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
    active: false,
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
      where: expect.objectContaining({ id: "routine-1", userId: "user-1", endsAt, active: false }),
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

  it("keeps a paused routine that still has runs left before its end", async () => {
    const { deps, deleteMany } = setup({ ...spent, endsAt: new Date("2026-11-30T00:00:00Z") });
    await expect(deleteSpentRoutine(deps, input)).resolves.toBe(false);
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
