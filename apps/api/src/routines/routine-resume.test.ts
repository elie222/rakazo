import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeRoutinesAfterRestore } from "./routine-resume.js";

type Row = {
  id: string;
  botId: string;
  userId: string;
  spaceId: string;
  crons: string[];
  timezone: string;
  watch: unknown;
  active: boolean;
  nextRunAt: Date | null;
  resumeOnRestore: boolean;
};

function routine(id: string, patch: Partial<Row> = {}): Row {
  return {
    id,
    botId: "bot-1",
    userId: "user-1",
    spaceId: "space-1",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    watch: null,
    active: false,
    nextRunAt: null,
    resumeOnRestore: true,
    ...patch,
  };
}

type Where = {
  botId: { in: string[] };
  userId: string;
  resumeOnRestore: boolean;
  id?: string;
};

function fixture(rows: Row[], archivedBots: string[] = []) {
  const matches = (row: Row, where: Where) =>
    where.botId.in.includes(row.botId) &&
    row.userId === where.userId &&
    row.resumeOnRestore === where.resumeOnRestore &&
    !archivedBots.includes(row.botId) &&
    (where.id === undefined || row.id === where.id);
  const lock = vi.fn(async () => []);
  const tx = {
    $queryRaw: lock,
    routine: {
      findFirst: vi.fn(
        async ({ where }: { where: Where }) => rows.find((row) => matches(row, where)) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) =>
        Object.assign(rows.find((row) => row.id === where.id)!, data),
      ),
    },
  };
  const prisma = {
    routine: {
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        rows.filter((row) => matches(row, where)),
      ),
    },
    $transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx)),
  } as unknown as PrismaClient;
  const enqueueIn = vi.fn(async () => undefined);
  const publishSpaceChange = vi.fn(async () => undefined);
  const deps = {
    prisma,
    jobs: { enqueueIn } as unknown as JobPublisher,
    events: { publishSpaceChange },
  };
  return { deps, tx, lock, enqueueIn, publishSpaceChange };
}

describe("resumeRoutinesAfterRestore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T08:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns a marked timer routine back on at its next occurrence, with its wakeup in the same transaction", async () => {
    const daily = routine("daily");
    const { deps, tx, lock, enqueueIn, publishSpaceChange } = fixture([daily]);

    await resumeRoutinesAfterRestore(deps, "user-1", ["bot-1"]);

    expect(daily).toMatchObject({
      active: true,
      nextRunAt: new Date("2026-03-01T09:00:00.000Z"),
      resumeOnRestore: false,
    });
    expect(lock).toHaveBeenCalledOnce();
    expect(enqueueIn).toHaveBeenCalledExactlyOnceWith(tx, expect.anything());
    expect(publishSpaceChange).toHaveBeenCalledExactlyOnceWith("space-1", "routines");
  });

  it("leaves another member's routine off, since it would run with their accounts", async () => {
    const mine = routine("mine");
    const theirs = routine("theirs", { userId: "user-2" });
    const { deps, enqueueIn } = fixture([mine, theirs]);

    await resumeRoutinesAfterRestore(deps, "user-1", ["bot-1"]);

    expect(mine.active).toBe(true);
    expect(theirs).toMatchObject({ active: false, nextRunAt: null, resumeOnRestore: true });
    expect(enqueueIn).toHaveBeenCalledOnce();
  });

  it("leaves a routine that was already off before the archive off", async () => {
    const paused = routine("paused", { resumeOnRestore: false });
    const { deps, enqueueIn } = fixture([paused]);

    await resumeRoutinesAfterRestore(deps, "user-1", ["bot-1"]);

    expect(paused).toMatchObject({ active: false, nextRunAt: null });
    expect(enqueueIn).not.toHaveBeenCalled();
  });

  it("checks a change trigger right away and turns an event-only routine on without a time", async () => {
    const watching = routine("watching", { crons: [], watch: { kind: "http" } });
    const webhook = routine("webhook", { crons: [] });
    const { deps, enqueueIn } = fixture([watching, webhook]);

    await resumeRoutinesAfterRestore(deps, "user-1", ["bot-1"]);

    expect(watching).toMatchObject({ active: true, nextRunAt: new Date(Date.now() + 2_000) });
    expect(webhook).toMatchObject({ active: true, nextRunAt: null, resumeOnRestore: false });
    expect(enqueueIn).toHaveBeenCalledOnce();
  });

  it("schedules from the routine as it stands under the lock, not as first listed", async () => {
    const edited = routine("edited");
    const { deps, lock } = fixture([edited]);
    // A member's edit lands after the listing and before the row lock is taken.
    lock.mockImplementationOnce(async () => {
      edited.crons = ["30 10 * * *"];
      return [];
    });

    await resumeRoutinesAfterRestore(deps, "user-1", ["bot-1"]);

    expect(edited.nextRunAt).toEqual(new Date("2026-03-01T10:30:00.000Z"));
  });

  it("does not turn on a routine a member turned off after the listing", async () => {
    const paused = routine("paused");
    const { deps, lock, enqueueIn } = fixture([paused]);
    // An explicit on or off clears the mark.
    lock.mockImplementationOnce(async () => {
      paused.resumeOnRestore = false;
      return [];
    });

    await resumeRoutinesAfterRestore(deps, "user-1", ["bot-1"]);

    expect(paused.active).toBe(false);
    expect(enqueueIn).not.toHaveBeenCalled();
  });

  it("keeps a one-time routine off, since archiving dropped its time, and clears its mark", async () => {
    const once = routine("once", { crons: ["@once"] });
    const { deps, enqueueIn } = fixture([once]);

    await resumeRoutinesAfterRestore(deps, "user-1", ["bot-1"]);

    expect(once).toMatchObject({ active: false, nextRunAt: null, resumeOnRestore: false });
    expect(enqueueIn).not.toHaveBeenCalled();
  });

  it("does nothing for a bot that is still archived", async () => {
    const daily = routine("daily");
    const { deps, enqueueIn } = fixture([daily], ["bot-1"]);

    await resumeRoutinesAfterRestore(deps, "user-1", ["bot-1"]);

    expect(daily).toMatchObject({ active: false, resumeOnRestore: true });
    expect(enqueueIn).not.toHaveBeenCalled();
  });
});
