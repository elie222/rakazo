import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UsageBreakdown, UsageBreakdownInput, UsageSummary } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../index.js";
import { asSystem } from "../system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeBreakdown = hasDb ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

describeBreakdown("usage.breakdown", () => {
  let app: App;
  let prisma: PrismaClient;
  let stop: () => Promise<void>;
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-usage-breakdown-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    prisma = asSystem(handles.prisma);
    stop = handles.stop;
  });

  afterAll(async () => {
    await stop?.();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  });
  afterEach(() => vi.useRealTimers());

  it("attributes usage to bots, counts a run once across its subagents and honours every filter", async () => {
    const cookie = await signup(app, `usage-breakdown-${stamp}@rakazo.test`, "Breakdown");
    const create = (name: string) =>
      rpc<{ id: string }>(app, cookie, "bots/create", {
        name,
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
    const alpha = await create("Alpha");
    const beta = await create("Beta");
    const gone = await create("Gone");
    const thread = await prisma.thread.findFirstOrThrow({ where: { botId: alpha.id } });
    const owner = { spaceId: thread.spaceId, userId: thread.userId };

    const runA1 = `run-a1-${stamp}`;
    const runA2 = `run-a2-${stamp}`;
    const runB = `run-b-${stamp}`;
    const runBOld = `run-b-old-${stamp}`;
    const runGone = `run-gone-${stamp}`;
    const now = Date.now();
    // Just after a UTC midnight, where a database session in another timezone is still on the
    // previous calendar day, so a day bucket cut in the session's timezone lands on the wrong day.
    const dayStart = now - (now % DAY);
    const row = (
      botId: string | null,
      runId: string | null,
      model: string,
      tokens: { input: number; output: number; cost: number },
      ageMs: number,
      extra: { operationKind?: string; agentId?: string } = {},
    ) => ({
      ...owner,
      botId,
      runId,
      parentRunId: runId,
      provider: "p",
      model,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      totalTokens: tokens.input + tokens.output,
      costUsd: tokens.cost,
      createdAt: new Date(dayStart - ageMs + 1000),
      ...extra,
    });
    await prisma.usageRecord.createMany({
      data: [
        row(alpha.id, runA1, "m1", { input: 100, output: 20, cost: 0.01 }, 0),
        // A subagent's call lands on its parent's run and bot.
        row(alpha.id, runA1, "m2", { input: 50, output: 10, cost: 0.005 }, 0, {
          operationKind: "subagent",
          agentId: "helper",
        }),
        row(alpha.id, runA2, "m1", { input: 10, output: 5, cost: 0.001 }, 2 * DAY),
        // Background work with no run is a call, not a run.
        row(alpha.id, null, "m1", { input: 5, output: 5, cost: 0.0005 }, 0, {
          operationKind: "compaction",
        }),
        row(beta.id, runB, "m2", { input: 1000, output: 100, cost: 0.1 }, 20 * DAY),
        row(beta.id, runBOld, "m2", { input: 4, output: 1, cost: 0.001 }, 400 * DAY),
        row(gone.id, runGone, "m1", { input: 7, output: 3, cost: 0.002 }, 0),
      ],
    });
    await rpc(app, cookie, "bots/remove", { botId: gone.id, deleteMemories: false });

    const other = await signup(app, `usage-breakdown-other-${stamp}@rakazo.test`, "Other");
    const otherBot = await rpc<{ id: string }>(app, other, "bots/create", {
      name: "Elsewhere",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const otherThread = await prisma.thread.findFirstOrThrow({ where: { botId: otherBot.id } });
    await prisma.usageRecord.create({
      data: {
        spaceId: otherThread.spaceId,
        userId: otherThread.userId,
        botId: otherBot.id,
        runId: `run-other-${stamp}`,
        parentRunId: `run-other-${stamp}`,
        provider: "p",
        model: "m1",
        inputTokens: 999_999,
        outputTokens: 1,
        totalTokens: 1_000_000,
        costUsd: 99,
      },
    });

    const get = (input: Partial<UsageBreakdownInput>) =>
      rpc<UsageBreakdown>(app, cookie, "usage/breakdown", input);
    const summary = (usage: UsageBreakdown) => ({
      runs: usage.totals.runs,
      calls: usage.totals.modelCalls,
      tokens: usage.totals.totalTokens,
    });
    const names = (usage: UsageBreakdown) => usage.bots.map((bot) => bot.name).sort();

    const month = await get({ range: "30d" });
    expect(summary(month)).toEqual({ runs: 4, calls: 6, tokens: 1315 });
    expect(month.totals).toMatchObject({ inputTokens: 1172, outputTokens: 143 });
    expect(month.totals.costUsd).toBeCloseTo(0.1185);
    expect(names(month)).toEqual(["Alpha", "Beta", "Gone"]);
    expect(month.bots.find((bot) => bot.id === alpha.id)).toMatchObject({
      runs: 2,
      modelCalls: 4,
      totalTokens: 205,
      deleted: false,
    });
    expect(month.bots.find((bot) => bot.id === gone.id)).toMatchObject({
      name: "Gone",
      deleted: true,
      runs: 1,
    });
    expect(month.models.map((m) => [m.model, m.modelCalls, m.totalTokens])).toEqual([
      ["m2", 2, 1160],
      ["m1", 4, 155],
    ]);
    // Every day of the range is a point; quiet days are zero.
    expect(month.overTimeUnit).toBe("day");
    expect(month.overTime).toHaveLength(30);
    const active = month.overTime.filter((p) => p.modelCalls > 0);
    expect(active.map((p) => [p.modelCalls, p.totalTokens])).toEqual([
      [1, 1100],
      [1, 15],
      [4, 200],
    ]);
    // Days are UTC days whatever timezone the database session runs in.
    expect(active.map((p) => p.date)).toEqual([
      utcDay(now - 20 * DAY),
      utcDay(now - 2 * DAY),
      utcDay(now),
    ]);

    expect(summary(await get({ range: "today" }))).toEqual({ runs: 2, calls: 4, tokens: 200 });
    expect(summary(await get({ range: "7d" }))).toEqual({ runs: 3, calls: 5, tokens: 215 });
    expect(summary(await get({ range: "all" }))).toEqual({ runs: 5, calls: 7, tokens: 1320 });

    const justAlpha = await get({ range: "30d", botId: alpha.id });
    expect(summary(justAlpha)).toEqual({ runs: 2, calls: 4, tokens: 205 });
    expect(justAlpha.totals.costUsd).toBeCloseTo(0.0165);
    // The selector keeps listing the other bots while one is selected.
    expect(names(justAlpha)).toEqual(["Alpha", "Beta", "Gone"]);

    const justModel = await get({ range: "30d", provider: "p", model: "m2" });
    expect(summary(justModel)).toEqual({ runs: 2, calls: 2, tokens: 1160 });
    // Picking a model never hides the other bots or models from the selectors.
    expect(names(justModel)).toEqual(["Alpha", "Beta", "Gone"]);
    expect(justModel.modelOptions.map((m) => m.model)).toEqual(["m2", "m1"]);
    expect(month.modelOptions.map((m) => m.model)).toEqual(["m2", "m1"]);

    const both = await get({ range: "30d", botId: alpha.id, provider: "p", model: "m2" });
    expect(summary(both)).toEqual({ runs: 1, calls: 1, tokens: 60 });

    const nobody = await get({ range: "today", botId: beta.id });
    expect(nobody.totals).toEqual({
      runs: 0,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    });

    // A call without a price makes the cost unknown rather than zero.
    await prisma.usageRecord.create({
      data: {
        ...owner,
        botId: alpha.id,
        runId: runA1,
        parentRunId: runA1,
        provider: "p",
        model: "unpriced",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    });
    const mixed = await get({ range: "30d", botId: alpha.id });
    expect(mixed.totals).toMatchObject({ runs: 2, modelCalls: 5, totalTokens: 207, costUsd: null });
    expect(mixed.models.find((m) => m.model === "unpriced")?.costUsd).toBeNull();
    expect(mixed.models.find((m) => m.model === "m1")?.costUsd).toBeCloseTo(0.0115);

    // A call with no token count leaves the total as the sum of the others, marked partial.
    await prisma.usageRecord.create({
      data: {
        ...owner,
        botId: alpha.id,
        runId: runA1,
        parentRunId: runA1,
        provider: "p",
        model: "interrupted",
        costUsd: 0,
      },
    });
    const partial = await get({ range: "30d", botId: alpha.id });
    expect(partial.totals).toMatchObject({ modelCalls: 6, totalTokens: 207, tokensPartial: true });
    expect(mixed.totals.tokensPartial).toBe(false);

    // Input read from the cache is its own figure, unknown where a call did not measure it.
    await prisma.usageRecord.createMany({
      data: [40, 2].map((cacheReadTokens) => ({
        ...owner,
        botId: alpha.id,
        runId: runA1,
        parentRunId: runA1,
        provider: "p",
        model: "caching",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens,
        // A measured cache read counts even when the call reported no total.
        totalTokens: cacheReadTokens === 2 ? null : cacheReadTokens + 2,
      })),
    });
    const cached = await get({ range: "30d", botId: alpha.id });
    expect(cached.models.find((m) => m.model === "caching")?.cachedTokens).toBe(42);
    expect(cached.models.find((m) => m.model === "m1")?.cachedTokens).toBeNull();
    // One call without the figure makes the model's sum unknown, even beside measured ones.
    await prisma.usageRecord.createMany({
      data: [5, null].map((cacheReadTokens) => ({
        ...owner,
        botId: alpha.id,
        runId: runA1,
        parentRunId: runA1,
        provider: "p",
        model: "mixed-cache",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens,
        totalTokens: 7,
      })),
    });
    const mixedCache = await get({ range: "30d", botId: alpha.id });
    expect(mixedCache.models.find((m) => m.model === "mixed-cache")?.cachedTokens).toBeNull();
    // A row from before cache reads were measured holds a zero and no total: still unknown.
    await prisma.usageRecord.create({
      data: {
        ...owner,
        botId: alpha.id,
        runId: runA1,
        parentRunId: runA1,
        provider: "p",
        model: "caching",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
      },
    });
    const older = await get({ range: "30d", botId: alpha.id });
    expect(older.models.find((m) => m.model === "caching")?.cachedTokens).toBeNull();

    const elsewhere = await rpc<UsageBreakdown>(app, other, "usage/breakdown", { range: "all" });
    expect(summary(elsewhere)).toEqual({ runs: 1, calls: 1, tokens: 1_000_000 });
    expect(names(elsewhere)).toEqual(["Elsewhere"]);
  }, 150000);

  it("splits usage by the routine that started each run", async () => {
    const cookie = await signup(app, `usage-breakdown-routine-${stamp}@rakazo.test`, "Routines");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Brief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Morning brief",
      prompt: "Send the morning brief",
      crons: ["0 8 * * *"],
      timezone: "UTC",
      active: false,
      notify: false,
    });
    const thread = await prisma.thread.findFirstOrThrow({ where: { botId: bot.id } });
    const owner = { spaceId: thread.spaceId, userId: thread.userId };
    const task = await prisma.task.create({
      data: { ...owner, botId: bot.id, threadId: thread.id, prompt: "p", status: "completed" },
    });
    const run = (routineId: string | null, delegatedFromRunId: string | null = null) =>
      prisma.run.create({
        data: {
          ...owner,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "completed",
          trigger: routineId ? "routine" : "user",
          routineId,
          delegatedFromRunId,
        },
      });
    const [first, second, chat] = [await run(routine.id), await run(routine.id), await run(null)];
    // Handed-on work is its own run, without a routine, that names the run it came from.
    const helper = await run(null, first.id);
    const helperOfHelper = await run(null, helper.id);
    const chatHelper = await run(null, chat.id);
    const record = (
      runId: string | null,
      parentRunId: string | null,
      model: string,
      n: number,
    ) => ({
      ...owner,
      botId: bot.id,
      runId,
      parentRunId,
      provider: "p",
      model,
      inputTokens: n,
      outputTokens: 0,
      totalTokens: n,
      costUsd: n / 1000,
    });
    await prisma.usageRecord.createMany({
      data: [
        record(first.id, first.id, "m1", 100),
        // A call inside the run counts with it, as does work the run handed on, however far.
        record(first.id, first.id, "m2", 50),
        record(helper.id, helper.id, "m2", 20),
        record(helperOfHelper.id, helperOfHelper.id, "m2", 5),
        record(second.id, second.id, "m1", 10),
        record(chat.id, chat.id, "m1", 7),
        record(chatHelper.id, chatHelper.id, "m1", 2),
        // Background work with no run belongs to no routine.
        record(null, null, "m1", 3),
      ],
    });

    const get = (input: Partial<UsageBreakdownInput>) =>
      rpc<UsageBreakdown>(app, cookie, "usage/breakdown", input);
    const rows = (usage: UsageBreakdown) =>
      usage.routines.map((row) => [row.id, row.name, row.botName, row.runs, row.totalTokens]);
    expect(rows(await get({ range: "30d" }))).toEqual([
      [routine.id, "Morning brief", "Brief", 4, 185],
      [null, null, null, 2, 12],
    ]);
    // The model filter narrows the split like every other figure.
    expect(rows(await get({ range: "30d", provider: "p", model: "m2" }))).toEqual([
      [routine.id, "Morning brief", "Brief", 3, 75],
    ]);

    // Deleting a routine keeps its usage, which is then no routine's.
    await rpc(app, cookie, "routines/remove", { routineId: routine.id });
    expect(rows(await get({ range: "30d" }))).toEqual([[null, null, null, 6, 197]]);
  });

  it("counts own-key media in cost and models without making token totals unknown", async () => {
    const cookie = await signup(app, `usage-media-${stamp}@rakazo.test`, "Media");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Painter",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const thread = await prisma.thread.findFirstOrThrow({ where: { botId: bot.id } });
    const row = (operationKind: string, model: string, costUsd: number, tokens: number | null) => ({
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId: bot.id,
      provider: "p",
      model,
      operationKind,
      billing: "api_key",
      costUsd,
      inputTokens: tokens,
      outputTokens: tokens,
      totalTokens: tokens === null ? null : tokens * 2,
    });
    await prisma.usageRecord.createMany({
      data: [
        row("answer", "lab/chat", 1, 500),
        row("image", "lab/draw", 0.04, null),
        row("video", "lab/clip", 0.2, null),
      ],
    });
    const usage = await rpc<UsageBreakdown>(app, cookie, "usage/breakdown", { range: "all" });
    expect(usage.totals).toMatchObject({ modelCalls: 3, totalTokens: 1000 });
    expect(usage.totals.costUsd).toBeCloseTo(1.24, 10);
    expect(usage.modelOptions.map((option) => option.model).sort()).toEqual([
      "lab/chat",
      "lab/clip",
      "lab/draw",
    ]);
    const summary = await rpc<UsageSummary>(app, cookie, "usage/summary");
    expect(summary).toMatchObject({ modelCalls: 3, totalTokens: 1000 });
    expect(summary.costUsd).toBeCloseTo(1.24, 10);
    expect(summary.models?.find((model) => model.model === "lab/draw")?.costUsd).toBeCloseTo(
      0.04,
      10,
    );
  });

  it.each([
    ["Pacific/Kiritimati", 14],
    ["Asia/Calcutta", 5.5],
    ["Asia/Rangoon", 6.5],
    ["Asia/Saigon", 7],
    ["America/Indianapolis", -5],
  ])("cuts today and day buckets at midnight in %s", async (timezone, hours) => {
    vi.setSystemTime(new Date("2026-01-31T09:59:30.000Z"));
    const offset = hours * 60 * 60 * 1000;
    const cookie = await signup(app, `usage-breakdown-tz-${stamp}-${hours}@rakazo.test`, "Zoned");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Zoned",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const thread = await prisma.thread.findFirstOrThrow({ where: { botId: bot.id } });
    await prisma.user.update({
      where: { id: thread.userId },
      data: { timezone },
    });
    const now = Date.now();
    const localMidnight = now + offset - ((now + offset) % DAY) - offset;
    const record = (createdAt: number) => ({
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId: bot.id,
      provider: "p",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costUsd: 0.001,
      createdAt: new Date(createdAt),
    });
    await prisma.usageRecord.createMany({
      data: [record(localMidnight + 1000), record(localMidnight - 1000)],
    });
    const today = await rpc<UsageBreakdown>(app, cookie, "usage/breakdown", { range: "today" });
    expect(today.totals.modelCalls).toBe(1);
    const all = await rpc<UsageBreakdown>(app, cookie, "usage/breakdown", { range: "all" });
    expect(all.overTime.map((p) => [p.date, p.modelCalls])).toEqual([
      [utcDay(localMidnight + offset - DAY), 1],
      [utcDay(localMidnight + offset), 1],
    ]);

    // A history longer than two months is drawn by month, quiet months included.
    await prisma.usageRecord.create({ data: record(localMidnight - 100 * DAY) });
    const long = await rpc<UsageBreakdown>(app, cookie, "usage/breakdown", { range: "all" });
    expect(long.overTimeUnit).toBe("month");
    expect(long.overTime.reduce((sum, p) => sum + p.modelCalls, 0)).toBe(3);
    expect(long.overTime.length).toBeGreaterThanOrEqual(4);
    expect(long.overTime.every((p) => p.date.endsWith("-01"))).toBe(true);

    await prisma.usageRecord.createMany({
      data: [6, 29].flatMap((days) => [
        record(localMidnight - days * DAY - 1000),
        record(localMidnight - days * DAY + 1000),
      ]),
    });
    await prisma.usageRecord.create({ data: record(Date.now() + 2 * DAY) });
    const current = await rpc<UsageBreakdown>(app, cookie, "usage/breakdown", { range: "today" });
    expect(current.totals.modelCalls).toBe(1);
    expect(current.overTime).toHaveLength(1);
    const complete = await rpc<UsageBreakdown>(app, cookie, "usage/breakdown", { range: "all" });
    expect(complete.totals.modelCalls).toBe(7);
    const week = await rpc<UsageBreakdown>(app, cookie, "usage/breakdown", { range: "7d" });
    expect(week.overTime).toHaveLength(7);
    expect(week.totals.modelCalls).toBe(3);
    expect(week.overTime[0]?.modelCalls).toBe(1);
    const month = await rpc<UsageBreakdown>(app, cookie, "usage/breakdown", { range: "30d" });
    expect(month.overTime).toHaveLength(30);
    expect(month.totals.modelCalls).toBe(5);
    expect(month.overTime[0]?.modelCalls).toBe(1);
  });
});

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}
