import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import {
  cancelScheduleFromTool,
  commandWatchFromTool,
  compactScheduleInput,
  createScheduleFromTool,
  filterBuiltinToolsForRun,
  filterBuiltinToolsForThread,
  isOneShotRoutineCron,
  listSchedulesFromTool,
  resolveScheduleTiming,
  SCHEDULE_TOOL_NAMES,
} from "./schedule-tools.js";

describe("resolveScheduleTiming", () => {
  it("rejects repeating intervals under one minute", () => {
    expect(resolveScheduleTiming({ every: 2, unit: "seconds" })).toEqual({
      ok: false,
      error: "minimum interval is 1 minute",
    });
  });

  it("accepts every 1 minute", () => {
    const result = resolveScheduleTiming({ every: 1, unit: "minutes" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe("*/1 * * * *");
    expect(result.oneShot).toBe(false);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("accepts cron every minute", () => {
    const result = resolveScheduleTiming({ cron: "*/1 * * * *" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe("*/1 * * * *");
    expect(result.oneShot).toBe(false);
  });

  it("creates one-shot schedules with @once cron", () => {
    const result = resolveScheduleTiming({ delayMinutes: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe(ONCE_ROUTINE_CRON);
    expect(result.oneShot).toBe(true);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it("allows sub-minute one-shot delays via delaySeconds", () => {
    const result = resolveScheduleTiming({ delaySeconds: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe(ONCE_ROUTINE_CRON);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it("rejects one-shot schedules in the past", () => {
    expect(resolveScheduleTiming({ runAt: new Date(Date.now() - 60_000).toISOString() })).toEqual({
      ok: false,
      error: "One-shot schedules must run in the future.",
    });
  });

  it("rejects fractional repeat intervals", () => {
    expect(resolveScheduleTiming({ every: 1.5, unit: "minutes" })).toEqual({
      ok: false,
      error: "every must be a positive whole number.",
    });
  });

  it("rejects malformed cron expressions", () => {
    expect(resolveScheduleTiming({ cron: "*/5 *" })).toEqual({
      ok: false,
      error: "cron must be a 5-field cron expression.",
    });
    expect(resolveScheduleTiming({ cron: "foo * * * *" })).toEqual({
      ok: false,
      error: "cron must be a valid 5-field cron expression.",
    });
  });

  it("rejects mixing repeat and one-shot fields", () => {
    expect(resolveScheduleTiming({ cron: "0 9 * * *", delayMinutes: 5 })).toEqual({
      ok: false,
      error: "Provide either a repeating schedule or a one-shot time, not both.",
    });
  });

  it("rejects two repeating timing methods", () => {
    expect(resolveScheduleTiming({ cron: "0 9 * * *", every: 1, unit: "hours" })).toEqual({
      ok: false,
      error: "Provide exactly one timing method: cron, or every and unit, not both.",
    });
  });

  it("ignores null and empty optional fields from model serializers", () => {
    const repeating = resolveScheduleTiming({
      cron: "0 9 * * *",
      every: null,
      unit: "",
      delayMinutes: null,
      runAt: "",
    });
    expect(repeating.ok).toBe(true);
    if (!repeating.ok) return;
    expect(repeating.oneShot).toBe(false);

    const oneShot = resolveScheduleTiming({
      cron: null,
      every: null,
      unit: "",
      delayMinutes: 10,
      delaySeconds: null,
    });
    expect(oneShot.ok).toBe(true);
    if (!oneShot.ok) return;
    expect(oneShot.oneShot).toBe(true);
  });

  it("keeps zero values for normal validation instead of treating them as absent", () => {
    expect(resolveScheduleTiming({ every: 0, unit: "minutes" })).toEqual({
      ok: false,
      error: "every must be a positive whole number.",
    });
    expect(compactScheduleInput({ every: 0, unit: "minutes", cron: null, runAt: "" })).toEqual({
      every: 0,
      unit: "minutes",
    });
  });
});

describe("filterBuiltinToolsForThread", () => {
  const tools = [
    { name: "handoff_to_bot" },
    { name: "message_bot" },
    { name: "schedule_create" },
    { name: "schedule_list" },
    { name: "schedule_cancel" },
    { name: "remember" },
  ];

  it("keeps handoff and schedule tools in groups", () => {
    expect(filterBuiltinToolsForThread(tools, "group-1").map((tool) => tool.name)).toEqual([
      "handoff_to_bot",
      "schedule_create",
      "schedule_list",
      "schedule_cancel",
      "remember",
    ]);
    expect(filterBuiltinToolsForThread(tools, null).map((tool) => tool.name)).toEqual([
      "message_bot",
      "schedule_create",
      "schedule_list",
      "schedule_cancel",
      "remember",
    ]);
  });

  it("hides schedule creation from routine runs without removing schedule management", () => {
    expect(filterBuiltinToolsForRun(tools, "routine").map((tool) => tool.name)).toEqual([
      "handoff_to_bot",
      "message_bot",
      "schedule_list",
      "schedule_cancel",
      "remember",
    ]);
    expect(filterBuiltinToolsForRun(tools, "user").map((tool) => tool.name)).toContain(
      "schedule_create",
    );
  });

  it("composes thread then run filters without dropping group schedule tools", () => {
    const groupTools = filterBuiltinToolsForRun(
      filterBuiltinToolsForThread(tools, "group-1"),
      "routine",
    ).map((tool) => tool.name);
    expect(groupTools).toEqual(["handoff_to_bot", "schedule_list", "schedule_cancel", "remember"]);
    expect(
      filterBuiltinToolsForRun(filterBuiltinToolsForThread(tools, "group-1"), "user").map(
        (tool) => tool.name,
      ),
    ).toContain("schedule_create");
  });

  it("covers every schedule tool name", () => {
    for (const name of SCHEDULE_TOOL_NAMES) {
      expect(filterBuiltinToolsForThread([{ name }, { name: "remember" }], "group-1")).toEqual([
        { name },
        { name: "remember" },
      ]);
    }
  });
});

describe("isOneShotRoutineCron", () => {
  it("detects the one-shot sentinel", () => {
    expect(isOneShotRoutineCron(ONCE_ROUTINE_CRON)).toBe(true);
    expect(isOneShotRoutineCron("0 9 * * *")).toBe(false);
  });
});

describe("schedule tool persistence", () => {
  it("creates routines with routine.created and enqueues wakeup", async () => {
    const append = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "routine-1",
      ...args.data,
      nextRunAt: args.data.nextRunAt,
    }));
    const deps = {
      prisma: { bot: { findFirst: vi.fn(async () => ({ computer: null })) }, routine: { create } },
      events: { append },
      jobs: { enqueue, cancel: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toMatchObject({ ok: true, routineId: "routine-1", cron: "*/1 * * * *" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spaceId: "ws-1",
          userId: "user-1",
          threadId: "thread-1",
          crons: ["*/1 * * * *"],
          active: true,
        }),
      }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.created", payload: { name: "Morning joke" } }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("createScheduleFromTool creates the routine for the target bot and thread", async () => {
    const append = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "routine-1",
      ...args.data,
    }));
    const deps = {
      prisma: { routine: { create } },
      events: { append },
      jobs: { enqueue, cancel: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      target: { botId: "child-1", threadId: "child-thread-1" },
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toMatchObject({ ok: true, routineId: "routine-1" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botId: "child-1", threadId: "child-thread-1" }),
      }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "routine.created",
        botId: "child-1",
        threadId: "child-thread-1",
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("keeps the routine when event append fails after enqueue", async () => {
    const cancel = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const deps = {
      prisma: {
        routine: {
          create: vi.fn(async () => ({
            id: "routine-1",
            name: "Morning joke",
            crons: ["*/1 * * * *"],
            nextRunAt: new Date(),
          })),
          delete: remove,
        },
      },
      events: {
        append: vi.fn(async () => {
          throw new Error("event failed");
        }),
      },
      jobs: { enqueue: vi.fn(async () => undefined), cancel },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toMatchObject({ ok: true, routineId: "routine-1" });
    expect(cancel).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("rolls back routine when enqueue fails", async () => {
    const remove = vi.fn(async () => undefined);
    const deps = {
      prisma: {
        routine: {
          create: vi.fn(async () => ({
            id: "routine-1",
            name: "Morning joke",
            crons: ["*/1 * * * *"],
            nextRunAt: new Date(),
          })),
          delete: remove,
        },
      },
      events: { append: vi.fn(async () => undefined) },
      jobs: {
        enqueue: vi.fn(async () => {
          throw new Error("enqueue failed");
        }),
        cancel: vi.fn(async () => undefined),
      },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toEqual({ error: "Could not schedule the reminder. Try again." });
    expect(remove).toHaveBeenCalledWith({ where: { id: "routine-1" } });
  });

  it("deactivates when enqueue fails and delete also fails", async () => {
    const update = vi.fn(async () => undefined);
    const deps = {
      prisma: {
        routine: {
          create: vi.fn(async () => ({
            id: "routine-1",
            name: "Morning joke",
            crons: ["*/1 * * * *"],
            nextRunAt: new Date(),
          })),
          delete: vi.fn(async () => {
            throw new Error("delete failed");
          }),
          update,
        },
      },
      events: { append: vi.fn(async () => undefined) },
      jobs: {
        enqueue: vi.fn(async () => {
          throw new Error("enqueue failed");
        }),
        cancel: vi.fn(async () => undefined),
      },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toEqual({ error: "Could not schedule the reminder. Try again." });
    expect(update).toHaveBeenCalledWith({
      where: { id: "routine-1" },
      data: { active: false, nextRunAt: null },
    });
  });

  it("propagates when enqueue rollback cannot deactivate", async () => {
    const deps = {
      prisma: {
        routine: {
          create: vi.fn(async () => ({
            id: "routine-1",
            name: "Morning joke",
            crons: ["*/1 * * * *"],
            nextRunAt: new Date(),
          })),
          delete: vi.fn(async () => {
            throw new Error("delete failed");
          }),
          update: vi.fn(async () => {
            throw new Error("deactivate failed");
          }),
        },
      },
      events: { append: vi.fn(async () => undefined) },
      jobs: {
        enqueue: vi.fn(async () => {
          throw new Error("enqueue failed");
        }),
        cancel: vi.fn(async () => undefined),
      },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    await expect(
      createScheduleFromTool(deps, {
        spaceId: "ws-1",
        botId: "bot-1",
        userId: "user-1",
        threadId: "thread-1",
        name: "Morning joke",
        prompt: "Tell a joke",
        schedule: { every: 1, unit: "minutes" },
      }),
    ).rejects.toThrow("deactivate failed");
  });

  it("scopes group list and cancel to the current thread without narrowing DMs", async () => {
    const findMany = vi.fn(async () => []);
    const findFirst = vi.fn(async () => null);
    const deps = {
      prisma: {
        routine: { findMany, findFirst, delete: vi.fn(async () => undefined) },
      },
      events: { append: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof cancelScheduleFromTool>[0];

    await listSchedulesFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "group-thread-1",
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          threadId: "group-thread-1",
        },
      }),
    );

    const cancelled = await cancelScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "group-thread-1",
      routineId: "routine-1",
    });
    expect(cancelled).toEqual({ error: "Schedule not found." });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          threadId: "group-thread-1",
          id: "routine-1",
        },
      }),
    );

    findMany.mockClear();
    await listSchedulesFromTool(deps, { spaceId: "ws-1", botId: "bot-1", userId: "user-1" });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "ws-1", botId: "bot-1", userId: "user-1" },
      }),
    );

    findFirst.mockClear();
    await cancelScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      routineId: "routine-1",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "ws-1", botId: "bot-1", userId: "user-1", id: "routine-1" },
      }),
    );
  });
});

describe("schedule_create with a watch", () => {
  function deps() {
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "routine-w",
      ...args.data,
    }));
    const enqueue = vi.fn(async () => undefined);
    return {
      create,
      enqueue,
      deps: {
        prisma: {
          connection: { findMany: vi.fn(async () => []) },
          bot: { findFirst: vi.fn(async () => ({ computer: null })) },
          routine: { create },
        },
        events: { append: vi.fn(async () => undefined) },
        jobs: { enqueue, cancel: vi.fn(async () => undefined) },
      } as unknown as Parameters<typeof createScheduleFromTool>[0],
    };
  }
  const base = {
    spaceId: "space-1",
    botId: "bot-1",
    userId: "user-1",
    threadId: "thread-1",
    name: "Brain check",
    prompt: "Summarize what changed",
  };

  it("creates an active routine with no schedule that checks right away", async () => {
    const { deps: d, create, enqueue } = deps();
    const result = await createScheduleFromTool(d, {
      ...base,
      schedule: { watch: { kind: "tool", tool: "brain_changed", args: { limit: 1 } } },
    });
    expect(result).toMatchObject({ ok: true, routineId: "routine-w" });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        crons: [],
        active: true,
        watch: expect.objectContaining({ kind: "tool", everyMinutes: 15, loud: false }),
      }),
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("rejects a team path escape before persisting", async () => {
    const { deps: d, create } = deps();
    vi.mocked(d.prisma.bot.findFirst).mockResolvedValue({ computer: { scope: "team" } } as never);
    const result = await createScheduleFromTool(d, {
      ...base,
      schedule: { watch: { kind: "files", paths: ["/etc"] } },
    });
    expect(result).toMatchObject({ error: expect.stringContaining("inside the bot's folder") });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a write tool before persisting", async () => {
    const { deps: d, create } = deps();
    d.connector = {
      discoverTools: vi.fn(async () => [
        { name: "send", readOnly: false, description: "Send", inputSchema: {} },
      ]),
    } as unknown as typeof d.connector;
    const result = await createScheduleFromTool(d, {
      ...base,
      schedule: { watch: { kind: "tool", tool: "send" } },
    });
    expect(result).toMatchObject({ error: expect.stringContaining("can change data") });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a caller outside the bot owner boundary", async () => {
    const { deps: d, create } = deps();
    vi.mocked(d.prisma.bot.findFirst).mockResolvedValue(null);
    const result = await createScheduleFromTool(d, {
      ...base,
      schedule: { watch: { kind: "command", command: "echo changed" } },
    });
    expect(result).toMatchObject({ error: "Bot not found." });
    expect(d.prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: base.botId, spaceId: base.spaceId, userId: base.userId, archivedAt: null },
      }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts the watch sent as JSON text", async () => {
    const { deps: d, create } = deps();
    const result = await createScheduleFromTool(d, {
      ...base,
      schedule: { watch: '{"kind":"files","paths":["inbox/"]}' },
    });
    expect(result).toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses a watch combined with a schedule, or an invalid watch", async () => {
    const { deps: d, create } = deps();
    expect(
      await createScheduleFromTool(d, {
        ...base,
        schedule: { cron: "0 9 * * *", watch: { kind: "files", paths: ["inbox"] } },
      }),
    ).toHaveProperty("error");
    expect(
      await createScheduleFromTool(d, { ...base, schedule: { watch: { kind: "files" } } }),
    ).toHaveProperty("error");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("command watch approval classification", () => {
  it("recognizes object and JSON command watches only", () => {
    const watch = { kind: "command", command: "echo changed" };
    expect(commandWatchFromTool(watch)).toBe("echo changed");
    expect(commandWatchFromTool(JSON.stringify(watch))).toBe("echo changed");
    expect(commandWatchFromTool({ kind: "files", paths: ["inbox"] })).toBeUndefined();
  });
});
