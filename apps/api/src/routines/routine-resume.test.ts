import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeRoutinesAfterRestore } from "./routine-resume.js";

type Row = {
  id: string;
  botId: string;
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
  resumeOnRestore: boolean;
  id?: string | { in: string[] };
  active?: boolean;
};

function fixture(rows: Row[], archivedBots: string[] = []) {
  const matches = (row: Row, where: Where) =>
    where.botId.in.includes(row.botId) &&
    row.resumeOnRestore === where.resumeOnRestore &&
    !archivedBots.includes(row.botId) &&
    (where.id === undefined ||
      (typeof where.id === "string" ? row.id === where.id : where.id.in.includes(row.id))) &&
    (where.active === undefined || row.active === where.active);
  const prisma = {
    routine: {
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        rows.filter((row) => matches(row, where)),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        const matched = rows.filter((row) => matches(row, where));
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      }),
    },
  } as unknown as PrismaClient;
  const enqueue = vi.fn(async () => undefined);
  const publishSpaceChange = vi.fn(async () => undefined);
  const deps = {
    prisma,
    jobs: { enqueue } as unknown as JobPublisher,
    events: { publishSpaceChange },
  };
  return { deps, enqueue, publishSpaceChange };
}

describe("resumeRoutinesAfterRestore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T08:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns a marked timer routine back on at its next occurrence and wakes it then", async () => {
    const daily = routine("daily");
    const { deps, enqueue, publishSpaceChange } = fixture([daily]);

    await resumeRoutinesAfterRestore(deps, ["bot-1"]);

    expect(daily).toMatchObject({
      active: true,
      nextRunAt: new Date("2026-03-01T09:00:00.000Z"),
      resumeOnRestore: false,
    });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(publishSpaceChange).toHaveBeenCalledExactlyOnceWith("space-1", "routines");
  });

  it("leaves a routine that was already off before the archive off", async () => {
    const paused = routine("paused", { resumeOnRestore: false });
    const { deps, enqueue } = fixture([paused]);

    await resumeRoutinesAfterRestore(deps, ["bot-1"]);

    expect(paused).toMatchObject({ active: false, nextRunAt: null });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("checks a change trigger right away and turns an event-only routine on without a time", async () => {
    const watching = routine("watching", { crons: [], watch: { kind: "http" } });
    const webhook = routine("webhook", { crons: [] });
    const { deps, enqueue } = fixture([watching, webhook]);

    await resumeRoutinesAfterRestore(deps, ["bot-1"]);

    expect(watching).toMatchObject({ active: true, nextRunAt: new Date(Date.now() + 2_000) });
    expect(webhook).toMatchObject({ active: true, nextRunAt: null, resumeOnRestore: false });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("keeps a one-time routine off, since archiving dropped its time, and clears its mark", async () => {
    const once = routine("once", { crons: ["@once"] });
    const { deps, enqueue } = fixture([once]);

    await resumeRoutinesAfterRestore(deps, ["bot-1"]);

    expect(once).toMatchObject({ active: false, nextRunAt: null, resumeOnRestore: false });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does nothing for a bot that is still archived", async () => {
    const daily = routine("daily");
    const { deps, enqueue } = fixture([daily], ["bot-1"]);

    await resumeRoutinesAfterRestore(deps, ["bot-1"]);

    expect(daily).toMatchObject({ active: false, resumeOnRestore: true });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
