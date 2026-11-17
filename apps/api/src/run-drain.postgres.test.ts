import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  InMemoryRealtimeFanout,
  RUN_DRAIN_MS,
  ScriptedAgentRuntime,
  wakeRun,
} from "@rakazo/adapters";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppHandles } from "./app.js";
import { createApp } from "./app.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("an API a deploy replaces, and the chat turns it is running (PostgreSQL)", () => {
  type Turn = { runId: string; signal: AbortSignal; finish: Deferred };
  const apis: Array<{ handles: AppHandles; turns: Turn[] }> = [];
  const organizations: string[] = [];
  let dataDir: string;
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let defaultModelBefore: {
    defaultModelProvider: string | null;
    defaultModelId: string | null;
  } | null;
  const wait = (assertion: () => Promise<void> | void) =>
    vi.waitFor(assertion, { timeout: 10_000, interval: 20 });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "rakazo-api-run-drain-"));
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
    defaultModelBefore = await system.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { defaultModelProvider: true, defaultModelId: true },
    });
    const model = { defaultModelProvider: "openrouter", defaultModelId: "openai/gpt-4o" };
    await system.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ...model },
      update: model,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const { turns } of apis) for (const turn of turns) turn.finish.resolve();
    await Promise.all(apis.splice(0).map(({ handles }) => handles.stop()));
    const ours = { space: { organizationId: { in: organizations } } };
    await system.run.updateMany({
      where: { ...ours, status: { in: ["queued", "leased", "running"] } },
      data: { status: "cancelled", leaseOwner: null, leaseExpiresAt: null },
    });
    await system.computerExecutionLease.deleteMany({ where: { computer: ours } });
  });

  afterAll(async () => {
    if (db) {
      // The row may be another file's by now, so only the two columns set here are put back.
      await system.deploymentSettings.update({
        where: { id: "default" },
        data: defaultModelBefore ?? { defaultModelProvider: null, defaultModelId: null },
      });
      await system.organization.deleteMany({ where: { id: { in: organizations } } });
      await system.user.deleteMany({ where: { id: { in: organizations } } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  /** An API process as production composes one; each model call is held until the test ends it. */
  async function startApi() {
    const turns: Turn[] = [];
    const runtime = {
      describe: () => ({
        ...new ScriptedAgentRuntime().describe(),
        capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
      }),
      abort: async () => undefined,
      async *run(_request: unknown, context: AdapterContext) {
        const turn = { runId: context.runId!, signal: context.signal, finish: deferred() };
        turns.push(turn);
        const aborted = deferred();
        const onAbort = () => aborted.reject(context.signal.reason);
        context.signal.addEventListener("abort", onAbort, { once: true });
        if (context.signal.aborted) onAbort();
        try {
          await Promise.race([turn.finish.promise, aborted.promise]);
        } finally {
          context.signal.removeEventListener("abort", onAbort);
        }
        yield { type: "done" as const, text: "Hello." };
      },
    };
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "graphile",
      deploymentModelKey: "fake-fixture-model-key",
      deploymentModelConfigured: true,
      realtime: new InMemoryRealtimeFanout(),
      runtime: runtime as unknown as AppHandles["runtime"],
    });
    apis.push({ handles, turns });
    return {
      handles,
      turnsOf: (runId: string) => turns.filter((turn) => turn.runId === runId),
      /** Makes a run due here, as the request that committed the message would. */
      wake: (runId: string) =>
        runAsSystem("api run drain fixture", () => wakeRun(handles.jobs, runId)),
      /** Asks this API to start a run directly, as a delivery or recovery scan would. */
      continueRun: async (runId: string, workerId: string) => {
        const owner = await system.run.findUniqueOrThrow({
          where: { id: runId },
          select: { spaceId: true, userId: true },
        });
        await runAsTenant(owner, () => handles.executor.continueRun(runId, workerId));
      },
    };
  }

  /** One person's bot with a computer, and a way to send it a chat message. */
  async function seedChat() {
    const id = randomUUID();
    organizations.push(id);
    await system.user.create({
      data: { id, name: "Drain fixture", email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({
      data: { id, name: "Drain fixture", slug: id, createdAt: new Date() },
    });
    await system.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    await system.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await system.spaceMember.create({
      data: {
        id,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const computer = await system.computer.create({
      data: { spaceId: id, userId: id, scopeKey: id, homeKey: id, kind: "fake", state: "running" },
    });
    const bot = await system.bot.create({
      data: { spaceId: id, userId: id, name: "Fixture", color: "test", computerId: computer.id },
    });
    const thread = await system.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    return async () => {
      const owner = { spaceId: id, userId: id, botId: bot.id, threadId: thread.id };
      const task = await system.task.create({
        data: { ...owner, prompt: "Say hello.", status: "queued" },
      });
      return system.run.create({
        data: { ...owner, taskId: task.id, trigger: "user", status: "queued" },
      });
    };
  }

  const runRow = (runId: string) => system.run.findUniqueOrThrow({ where: { id: runId } });
  const attemptsOf = async (runId: string) =>
    (await system.attempt.findMany({ where: { runId }, orderBy: { fence: "asc" } })).map(
      ({ fence, status }) => ({ fence, status }),
    );
  const repliesOf = (runId: string) => system.message.count({ where: { runId, role: "bot" } });

  async function turnInFlight(api: Awaited<ReturnType<typeof startApi>>) {
    const run = await (await seedChat())();
    await api.wake(run.id);
    await wait(() => expect(api.turnsOf(run.id)).toHaveLength(1));
    return { run, turn: api.turnsOf(run.id)[0]! };
  }

  it("lets the chat turn in flight end on the API that is stopping, with one model call", async () => {
    const leaving = await startApi();
    const { run, turn } = await turnInFlight(leaving);
    const replacement = await startApi();

    let stopped = false;
    const stop = leaving.handles.stop({ letRunsFinish: true }).then(() => {
      stopped = true;
    });
    expect(turn.signal.aborted).toBe(false);
    // The replacement is told the run is ready, as a handoff or a recovery scan would.
    await replacement.continueRun(run.id, "replacement");
    expect(turn.signal.aborted).toBe(false);
    expect(stopped).toBe(false);
    expect(replacement.turnsOf(run.id)).toHaveLength(0);
    expect((await runRow(run.id)).status).toBe("running");

    turn.finish.resolve();
    await stop;

    expect(await runRow(run.id)).toMatchObject({ status: "completed", error: null, leaseFence: 1 });
    expect(await attemptsOf(run.id)).toEqual([{ fence: 1, status: "completed" }]);
    expect(await repliesOf(run.id)).toBe(1);
    expect(leaving.turnsOf(run.id)).toHaveLength(1);
    expect(replacement.turnsOf(run.id)).toHaveLength(0);
  });

  it("claims and starts no new run once it is stopping, while requests still finish", async () => {
    const leaving = await startApi();
    const { turn } = await turnInFlight(leaving);
    const connections = deferred();
    const stop = leaving.handles.stop({
      letRunsFinish: true,
      connectionsClosed: connections.promise,
    });

    const delivered = await (await seedChat())();
    await leaving.continueRun(delivered.id, "leaving");
    await leaving.wake(delivered.id);
    expect(await runRow(delivered.id)).toMatchObject({ status: "queued", leaseOwner: null });
    expect(await attemptsOf(delivered.id)).toEqual([]);
    expect(leaving.turnsOf(delivered.id)).toHaveLength(0);

    turn.finish.resolve();
    connections.resolve();
    await stop;
  });

  it("hands a turn still running at the drain limit back for another process to resume", async () => {
    const leaving = await startApi();
    const { run, turn } = await turnInFlight(leaving);
    const replacement = await startApi();

    // Only the drain limit is on the fake clock; it starts when the stop does.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stop = leaving.handles.stop({ letRunsFinish: true });
    vi.advanceTimersByTime(RUN_DRAIN_MS - 1);
    expect(turn.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(turn.signal.aborted).toBe(true);
    vi.useRealTimers();
    await stop;

    expect(await runRow(run.id)).toMatchObject({ status: "queued", leaseOwner: null });
    expect(await attemptsOf(run.id)).toEqual([{ fence: 1, status: "interrupted" }]);
    const resumed = replacement.continueRun(run.id, "replacement");
    await wait(() => expect(replacement.turnsOf(run.id)).toHaveLength(1));
    replacement.turnsOf(run.id)[0]!.finish.resolve();
    await resumed;
    expect(await attemptsOf(run.id)).toEqual([
      { fence: 1, status: "interrupted" },
      { fence: 2, status: "completed" },
    ]);
    expect(await repliesOf(run.id)).toBe(1);
  });

  it("hands the turns back at once when a stop that hands back arrives during the drain", async () => {
    const leaving = await startApi();
    const { run, turn } = await turnInFlight(leaving);

    const connections = deferred();
    const draining = leaving.handles.stop({
      letRunsFinish: true,
      connectionsClosed: connections.promise,
    });
    expect(turn.signal.aborted).toBe(false);
    // Requests are still finishing, and the turns go back all the same.
    const stopped = leaving.handles.stop();
    expect(turn.signal.aborted).toBe(true);
    connections.resolve();
    await Promise.all([draining, stopped]);

    expect(await runRow(run.id)).toMatchObject({ status: "queued", leaseOwner: null });
    expect(await attemptsOf(run.id)).toEqual([{ fence: 1, status: "interrupted" }]);
  });

  it("leaves the turn of an API killed while draining to lease expiry, then refuses its late result", async () => {
    const killed = await startApi();
    const { run, turn } = await turnInFlight(killed);
    const stop = killed.handles.stop({ letRunsFinish: true });
    expect(turn.signal.aborted).toBe(false);
    const replacement = await startApi();

    // While its leases last, the run stays with the API that claimed it.
    await replacement.continueRun(run.id, "replacement");
    expect(replacement.turnsOf(run.id)).toHaveLength(0);

    // A killed process renews nothing, so in time both leases run out.
    const expired = new Date(Date.now() - 1_000);
    await system.run.update({ where: { id: run.id }, data: { leaseExpiresAt: expired } });
    await system.computerExecutionLease.updateMany({
      where: { runId: run.id },
      data: { expiresAt: expired },
    });
    const resumed = replacement.continueRun(run.id, "replacement");
    await wait(() => expect(replacement.turnsOf(run.id)).toHaveLength(1));
    replacement.turnsOf(run.id)[0]!.finish.resolve();
    await resumed;

    // Had it only stalled, its turn ending now must not complete the run a second time.
    turn.finish.resolve();
    await stop;
    expect(await runRow(run.id)).toMatchObject({ status: "completed", error: null, leaseFence: 2 });
    expect(await attemptsOf(run.id)).toEqual([
      { fence: 1, status: "interrupted" },
      { fence: 2, status: "completed" },
    ]);
    expect(await repliesOf(run.id)).toBe(1);
  });
});
