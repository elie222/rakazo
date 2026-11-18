import { describe, expect, it, vi } from "vitest";
import { createScheduleFromTool, updateScheduleFromTool } from "./schedule-tools.js";

function world(existing?: Record<string, unknown>) {
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "r-new",
    ...args.data,
  }));
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const enqueue = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => undefined);
  const client = {
    bot: {
      findFirst: vi.fn(async () => ({ id: "bot-1", userId: "u", computer: null })),
      findMany: vi.fn(async () => [{ id: "bot-1", name: "Writer", thread: { id: "thread-1" } }]),
    },
    user: { findUnique: vi.fn(async () => ({ timezone: "UTC" })) },
    routine: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => existing ?? null),
      create,
      updateMany,
    },
    $queryRaw: async () => [{ timezone: "UTC" }],
  };
  const prisma = {
    ...client,
    $transaction: async (run: (c: unknown) => Promise<unknown>) => run(client),
  };
  const deps = {
    prisma,
    events: { append: vi.fn(async () => undefined), publishSpaceChange: vi.fn() },
    jobs: { enqueue, cancel },
  } as never;
  return { deps, create, updateMany, enqueue, cancel };
}

const base = {
  spaceId: "ws",
  botId: "bot-1",
  userId: "u",
  threadId: "thread-1",
  name: "Watcher",
  prompt: "report the change",
};
const command = { kind: "command", command: "ls inbox", everyMinutes: 30 };

describe("schedule_create with a command watch", () => {
  it("is live when the call is trusted", async () => {
    const w = world();
    const result = await createScheduleFromTool(w.deps, {
      ...base,
      schedule: { watch: command },
      commandWatchTrusted: true,
    });
    expect(result).toMatchObject({ ok: true, routineId: "r-new" });
    expect(result).not.toHaveProperty("active");
    expect(w.create.mock.calls[0]![0].data).toMatchObject({ active: true });
    expect(w.create.mock.calls[0]![0].data.nextRunAt).toBeInstanceOf(Date);
    expect(w.enqueue).toHaveBeenCalledOnce();
  });

  it.each([false, undefined])(
    "is saved turned off when the call is not trusted (%s): no wakeup, and the bot is told",
    async (trusted) => {
      const w = world();
      const result = await createScheduleFromTool(w.deps, {
        ...base,
        schedule: { watch: command },
        ...(trusted === undefined ? {} : { commandWatchTrusted: trusted }),
      });
      expect(result).toMatchObject({ ok: true, active: false });
      expect((result as { note: string }).note).toMatch(/turned off.*Tell the user/);
      expect(w.create.mock.calls[0]![0].data).toMatchObject({ active: false, nextRunAt: null });
      expect(w.enqueue).not.toHaveBeenCalled();
    },
  );

  it("leaves the other watches alone", async () => {
    const w = world();
    await createScheduleFromTool(w.deps, {
      ...base,
      schedule: { watch: { kind: "files", paths: ["inbox"], everyMinutes: 30 } },
    });
    expect(w.create.mock.calls[0]![0].data).toMatchObject({ active: true });
    expect(w.enqueue).toHaveBeenCalledOnce();
  });
});

describe("schedule_update on a command watch", () => {
  const watchRow = (extra: Record<string, unknown> = {}) => ({
    id: "r1",
    spaceId: "ws",
    botId: "bot-1",
    userId: "u",
    threadId: "thread-1",
    name: "Watcher",
    prompt: "p",
    active: false,
    crons: [],
    timezone: "UTC",
    nextRunAt: null,
    watch: command,
    ...extra,
  });
  const live = { active: true, nextRunAt: new Date("2030-01-01T00:00:00Z") };
  const update = (userId: string, extra: Record<string, unknown> = {}) => ({
    spaceId: "ws",
    botId: "bot-1",
    userId,
    threadId: "thread-1",
    routineId: "r1",
    schedule: {},
    ...extra,
  });

  it("never turns one on, whoever asks and whatever else it edits", async () => {
    for (const who of ["u", "other"]) {
      const w = world(watchRow());
      for (const extra of [{ active: true }, { active: true, prompt: "q" }]) {
        expect(await updateScheduleFromTool(w.deps, update(who, extra))).toHaveProperty(
          "error",
          expect.stringMatching(/only be turned on in the app/),
        );
      }
      expect(w.updateMany).not.toHaveBeenCalled();
      expect(w.enqueue).not.toHaveBeenCalled();
    }
  });

  it("lets the owner edit it and pause it", async () => {
    const w = world(watchRow(live));
    expect(await updateScheduleFromTool(w.deps, update("u", { prompt: "new" }))).toMatchObject({
      ok: true,
      active: true,
    });
    expect(await updateScheduleFromTool(w.deps, update("u", { active: false }))).toMatchObject({
      ok: true,
      active: false,
    });
  });

  it("leaves it off when another member takes it over by editing it", async () => {
    const w = world(watchRow(live));
    const result = await updateScheduleFromTool(w.deps, update("other", { prompt: "mine now" }));
    expect(result).toMatchObject({ ok: true, active: false, nextRunAt: null });
    expect((result as { note: string }).note).toMatch(/turned off/);
    const data = (w.updateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
      .data;
    expect(data).toMatchObject({ userId: "other", active: false, nextRunAt: null });
    expect(w.enqueue).not.toHaveBeenCalled();
    expect(w.cancel).toHaveBeenCalled();
  });

  it("keeps a takeover of a watch that is already off, off", async () => {
    const w = world(watchRow());
    const result = await updateScheduleFromTool(w.deps, update("other", { name: "Mine" }));
    expect(result).toMatchObject({ ok: true, active: false });
    expect(w.enqueue).not.toHaveBeenCalled();
    // Fenced on what it read, so an owner who turned the watch on meanwhile keeps it.
    const where = (w.updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0]
      .where;
    expect(where).toMatchObject({ userId: "u", active: false, nextRunAt: null });
  });

  it("resumes only the watch it read: a command put there since is not started", async () => {
    const w = world(
      watchRow({ watch: { kind: "files", paths: ["inbox"], everyMinutes: 30 }, active: false }),
    );
    await updateScheduleFromTool(w.deps, update("u", { active: true }));
    const where = (w.updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0]
      .where;
    expect(where).toMatchObject({
      active: false,
      watch: { equals: { kind: "files", paths: ["inbox"], everyMinutes: 30 } },
    });
  });

  it("does not turn off a takeover of a watch that runs no command", async () => {
    const w = world(
      watchRow({ ...live, watch: { kind: "files", paths: ["inbox"], everyMinutes: 30 } }),
    );
    expect(await updateScheduleFromTool(w.deps, update("other", { prompt: "x" }))).toMatchObject({
      ok: true,
      active: true,
    });
  });

  it("cannot change the command: a watch takes no new timing through the tool", async () => {
    const w = world(watchRow(live));
    const result = await updateScheduleFromTool(
      w.deps,
      update("u", { schedule: { every: 5, unit: "minutes" } }),
    );
    expect(result).toHaveProperty("error");
    expect(w.updateMany).not.toHaveBeenCalled();
  });
});
