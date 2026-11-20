import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { modelListCost } from "@rakazo/adapters";
import type { UsageBreakdown, UsageBreakdownInput } from "@rakazo/contracts";
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
      apiCostUsd: 0,
      apiCostEstimated: false,
      incomplete: [],
    });

    // A call without a price leaves the cost a floor, and its own model's cost unknown.
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
    expect(mixed.totals).toMatchObject({
      runs: 2,
      modelCalls: 5,
      totalTokens: 207,
      incomplete: ["costUsd", "apiCostUsd"],
    });
    expect(mixed.totals.costUsd).toBeCloseTo(0.0165);
    expect(mixed.models.find((m) => m.model === "unpriced")?.costUsd).toBeNull();
    expect(mixed.models.find((m) => m.model === "m1")?.costUsd).toBeCloseTo(0.0115);
    // It has no list price either, so the API cost is the priced calls' cost and a floor.
    expect(mixed.totals.apiCostUsd).toBeCloseTo(0.0165);
    expect(mixed.models.find((m) => m.model === "unpriced")?.apiCostUsd).toBeNull();
    expect(mixed.totals.apiCostEstimated).toBe(false);

    // A call without a cost on a listed model, such as one a subscription covers, gets its list price.
    await prisma.usageRecord.create({
      data: {
        ...owner,
        botId: alpha.id,
        runId: runA1,
        parentRunId: runA1,
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        inputTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
      },
    });
    const listPrice = modelListCost("anthropic", "claude-sonnet-5-5", {
      calls: 1,
      counted: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 },
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })?.usd;
    expect(listPrice).toBeGreaterThan(0);
    const listed = await get({ range: "30d", botId: alpha.id });
    expect(listed.models.find((m) => m.model === "claude-sonnet-5-5")?.apiCostUsd).toBeCloseTo(
      listPrice!,
    );
    expect(listed.totals.apiCostUsd).toBeCloseTo(0.0165 + listPrice!);
    expect(listed.totals.apiCostEstimated).toBe(true);
    expect(listed.overTime.reduce((sum, point) => sum + (point.apiCostUsd ?? 0), 0)).toBeCloseTo(
      0.0165 + listPrice!,
    );

    // A month whose only call reports no tokens or cost reads unknown, not zero.
    await prisma.usageRecord.create({
      data: {
        ...owner,
        botId: alpha.id,
        provider: "p",
        model: "unpriced",
        createdAt: new Date(dayStart - 200 * DAY),
      },
    });
    const history = await get({ range: "all", botId: alpha.id });
    expect(history.overTimeUnit).toBe("month");
    const quietMonth = `${utcDay(dayStart - 200 * DAY).slice(0, 7)}-01`;
    expect(history.overTime.find((point) => point.date === quietMonth)).toMatchObject({
      modelCalls: 1,
      totalTokens: null,
      costUsd: null,
      apiCostUsd: null,
    });

    // A call on that model without token counts leaves its list price standing, as a floor.
    await prisma.usageRecord.create({
      data: {
        ...owner,
        botId: alpha.id,
        runId: runA1,
        parentRunId: runA1,
        provider: "anthropic",
        model: "claude-sonnet-5-5",
      },
    });
    const uncounted = (await get({ range: "30d", botId: alpha.id })).models.find(
      (m) => m.model === "claude-sonnet-5-5",
    );
    expect(uncounted?.apiCostUsd).toBeCloseTo(listPrice!);
    expect(uncounted?.incomplete).toContain("apiCostUsd");

    // A listed model whose only call has no counts has nothing to price, so its cost stays unknown.
    await prisma.usageRecord.create({
      data: {
        ...owner,
        botId: alpha.id,
        runId: runA1,
        parentRunId: runA1,
        provider: "anthropic",
        model: "claude-opus-5-5",
      },
    });
    const nothing = (await get({ range: "30d", botId: alpha.id })).models.find(
      (m) => m.model === "claude-opus-5-5",
    );
    expect(nothing).toMatchObject({ apiCostUsd: null, apiCostEstimated: false });

    // A call that reports only cache tokens is still priced, as a floor.
    await prisma.usageRecord.create({
      data: {
        ...owner,
        botId: alpha.id,
        runId: runA1,
        parentRunId: runA1,
        provider: "anthropic",
        model: "claude-haiku-5-5",
        cacheReadTokens: 1_000_000,
      },
    });
    const cacheOnly = (await get({ range: "30d", botId: alpha.id })).models.find(
      (m) => m.model === "claude-haiku-5-5",
    );
    expect(cacheOnly?.apiCostUsd).toBeGreaterThan(0);
    expect(cacheOnly).toMatchObject({ apiCostEstimated: true });
    expect(cacheOnly?.incomplete).toContain("apiCostUsd");

    const elsewhere = await rpc<UsageBreakdown>(app, other, "usage/breakdown", { range: "all" });
    expect(summary(elsewhere)).toEqual({ runs: 1, calls: 1, tokens: 1_000_000 });
    expect(names(elsewhere)).toEqual(["Elsewhere"]);
  }, 150000);

  it("cuts today and day buckets at the member's own midnight", async () => {
    vi.setSystemTime(new Date(`${utcDay(Date.now())}T09:59:30.000Z`));
    const offset = 14 * 60 * 60 * 1000;
    const cookie = await signup(app, `usage-breakdown-tz-${stamp}@rakazo.test`, "Zoned");
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
      data: { timezone: "Pacific/Kiritimati" },
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
