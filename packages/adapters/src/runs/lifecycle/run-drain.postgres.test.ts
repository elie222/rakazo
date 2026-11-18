import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterContext,
  AgentRunRequest,
  BackgroundJobHandlers,
  JobPublisher,
} from "@rakazo/adapter-kit";
import type { ToolHistory } from "@rakazo/contracts";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  cancelRunsInTransaction,
  createDb,
  createThreadEvents,
  loadRunTurnCheckpoint,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryRealtimeFanout } from "../../notifications/realtime.js";
import { FakeSandboxProvider } from "../../providers/computer/fake/fake-sandbox.js";
import { ScriptedAgentRuntime } from "../../runtime/scripted-runtime.js";
import { EncryptedSecretStore } from "../../secrets/secrets.js";
import { LocalAgentHomeStore } from "../../storage/home.js";
import { createRunExecutor } from "../executor/executor.js";
import type { TurnCheckpoint } from "../turn/turn-checkpoint.js";
import { serializeTurnCheckpoint } from "../turn/turn-checkpoint.js";
import {
  drainRuns,
  RUN_DRAIN_MS,
  RunJobPublisher,
  RunStarter,
  RunWorkerHost,
} from "../wakeups/run-wakeup.js";
import { wakeRun } from "../wakeups/wake-run.js";
import type * as RunLifecycle from "./run-lifecycle.js";

/** Arms the next workspace flush to fail, as a sandbox that cannot save its files would. */
const workspaceFlush = vi.hoisted(() => ({ failNext: false }));
vi.mock("./run-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RunLifecycle>();
  return {
    ...actual,
    createRunWorkspaceCheckpoint: (
      ...args: Parameters<typeof actual.createRunWorkspaceCheckpoint>
    ) => {
      const checkpoint = actual.createRunWorkspaceCheckpoint(...args);
      return {
        ...checkpoint,
        flush: async () => {
          if (!workspaceFlush.failNext) return checkpoint.flush();
          workspaceFlush.failNext = false;
          throw new Error("Workspace flush failed");
        },
      };
    },
  };
});

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("a stopping process and the runs it is executing (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let dataDir: string;
  const organizations: string[] = [];
  let defaultModelBefore: {
    defaultModelProvider: string | null;
    defaultModelId: string | null;
  } | null;
  /** One step of a turn: a model call held open until the test ends it. */
  type Turn = { runId: string; step: number; signal: AbortSignal; finish: Deferred };
  const processes: Array<{ turns: Turn[]; exit: () => Promise<void> }> = [];
  const wait = (assertion: () => Promise<void> | void) =>
    vi.waitFor(assertion, { timeout: 10_000, interval: 20 });

  beforeAll(async () => {
    db = createDb(url!);
    prisma = db.prisma;
    system = asSystem(prisma);
    dataDir = await mkdtemp(join(tmpdir(), "rakazo-run-drain-"));
    defaultModelBefore = await system.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { defaultModelProvider: true, defaultModelId: true },
    });
    await system.deploymentSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        defaultModelProvider: "openrouter",
        defaultModelId: "openai/gpt-4o",
      },
      update: { defaultModelProvider: "openrouter", defaultModelId: "openai/gpt-4o" },
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // A turn still held open would keep its process from stopping.
    for (const { turns } of processes) for (const turn of turns) turn.finish.resolve();
    await Promise.all(processes.splice(0).map(({ exit }) => exit()));
    // Every process scans the whole database, so nothing a test here left may stay runnable.
    const ours = { space: { organizationId: { in: organizations } } };
    await system.run.updateMany({
      where: { ...ours, status: { in: ["queued", "leased", "running"] } },
      data: { status: "cancelled", leaseOwner: null, leaseExpiresAt: null },
    });
    await system.computerExecutionLease.deleteMany({ where: { computer: ours } });
  });

  afterAll(async () => {
    if (!prisma) return;
    // The row may be another file's by now, so only the two columns set here are put back.
    await system.deploymentSettings.update({
      where: { id: "default" },
      data: defaultModelBefore ?? { defaultModelProvider: null, defaultModelId: null },
    });
    await system.organization.deleteMany({ where: { id: { in: organizations } } });
    await system.user.deleteMany({ where: { id: { in: organizations } } });
    await prisma.$disconnect();
    await db.pool.end();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** One person's bot with a computer, and a way to give it runs. */
  async function seedBot() {
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
    const createRun = async () => {
      const owner = { spaceId: id, userId: id, botId: bot.id, threadId: thread.id };
      const task = await system.task.create({
        data: { ...owner, prompt: "Say hello.", status: "queued" },
      });
      return system.run.create({
        data: { ...owner, taskId: task.id, trigger: "routine", status: "queued" },
      });
    };
    return { createRun };
  }

  /** The saved turn of a run that finished `steps` steps, in the shape the executor restores. */
  const checkpointAfter = (steps: number) =>
    serializeTurnCheckpoint({
      version: 1,
      provider: "openrouter",
      model: "openai/gpt-4o",
      systemPrompt: "",
      pendingToolCallId: "",
      messages: Array.from({ length: steps }, (_, step) => ({
        role: "toolResult" as const,
        toolCallId: `step-${step}`,
        toolName: "list_files",
        content: [],
        isError: false,
        timestamp: 0,
      })),
    });

  /**
   * A process as the worker composes one: its own run starter, recovery scan and executor on
   * the shared database. Each turn takes `steps` steps, and each step's model call is held open
   * until the test ends it. Between steps a stopping process's turn hands itself back.
   */
  function startProcess(workerId: string, options: { drains: boolean; steps?: number }) {
    const steps = options.steps ?? 1;
    const stopping = new AbortController();
    const drain = options.drains ? drainRuns(stopping.signal) : undefined;
    const starter = new RunStarter(realtime, { signal: stopping.signal });
    const jobs = new RunJobPublisher(
      prisma,
      {
        enqueue: vi.fn(),
        cancel: vi.fn(),
        cancelIn: vi.fn(),
        close: vi.fn(),
      } as unknown as JobPublisher,
      starter,
    );
    const turns: Turn[] = [];
    const runtime = {
      describe: () => ({
        ...new ScriptedAgentRuntime().describe(),
        capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
      }),
      abort: async () => undefined,
      async *run(request: AgentRunRequest, context: AdapterContext) {
        await request.executeTool!("list_files", { path: "drain-fixture" }, "drain-computer-use");
        const resumedAt = request.turnCheckpoint
          ? (JSON.parse(request.turnCheckpoint) as TurnCheckpoint).messages.length
          : 0;
        let handBackFailed = false;
        for (let step = resumedAt; step < steps; step++) {
          if (step > resumedAt && request.yieldSignal?.aborted && !handBackFailed) {
            const answer = deferred<boolean>();
            const checkpoint = checkpointAfter(step);
            yield { type: "yielded" as const, checkpoint, answer: answer.resolve };
            if (await answer.promise) return;
            handBackFailed = true;
          }
          const turn = { runId: context.runId!, step, signal: context.signal, finish: deferred() };
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
          if (steps === 1) continue;
          // The step's model call asked for a tool, which runs before the next step.
          const call = { name: "list_files", executionId: `step-${step}` };
          const args = { path: `step-${step}` };
          yield { type: "tool" as const, ...call, args, response: step };
          const result = await request.executeTool!(call.name, args, call.executionId);
          await request.onToolCompleted?.({ ...call, durationMs: 0, result });
        }
        yield { type: "done" as const, text: `Hello from ${workerId}.` };
      },
    };
    const executor = createRunExecutor({
      prisma,
      events: createThreadEvents(prisma, realtime),
      jobs,
      sandbox,
      runtime,
      home: new LocalAgentHomeStore(dataDir),
      memory: { read: async () => ({ documents: [] }) },
      memoryProviders: { resolve: async () => null },
      secretStore: new EncryptedSecretStore("fake-fixture-encryption-key"),
      secrets: [],
      deploymentModelKey: "fake-fixture-model-key",
      deploymentModelConfigured: true,
      dataDir,
      ...(drain
        ? { stoppingSignal: stopping.signal, shutdownSignal: drain.signal }
        : { shutdownSignal: stopping.signal }),
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    const continueRun = async (runId: string, onRunStarted?: () => void) => {
      const owner = await system.run.findUniqueOrThrow({
        where: { id: runId },
        select: { spaceId: true, userId: true },
      });
      await runAsTenant(owner, () => executor.continueRun(runId, workerId, onRunStarted));
    };
    const host = new RunWorkerHost(prisma, realtime, starter, { intervalMs: 25 });
    let stopped: Promise<void> | undefined;
    const stop = () => {
      stopping.abort();
      stopped ??= host.stop();
      return stopped;
    };
    const exit = async () => {
      drain?.end();
      await stop();
    };
    processes.push({ turns, exit });
    return {
      jobs,
      continueRun,
      start: () =>
        host.start({
          "run.continue": ({ runId }, execution) => continueRun(runId, execution?.onRunStarted),
        } as BackgroundJobHandlers),
      /** The stop signal arrives: the worker aborts its shutdown signal first. */
      signalStop: () => stopping.abort(),
      /** Then it stops its hosts, which wait for the runs it is executing. */
      stop,
      turnsOf: (runId: string) => turns.filter((turn) => turn.runId === runId),
    };
  }

  const realtime = new InMemoryRealtimeFanout();
  const sandbox = new FakeSandboxProvider();
  const runRow = (runId: string) => system.run.findUniqueOrThrow({ where: { id: runId } });
  const attemptsOf = async (runId: string) =>
    (await system.attempt.findMany({ where: { runId }, orderBy: { fence: "asc" } })).map(
      ({ fence, status }) => ({ fence, status }),
    );
  const repliesOf = (runId: string) => system.message.count({ where: { runId, role: "bot" } });
  /**
   * Lets a test say a minute has passed for the lease heartbeats started from here on. Each
   * beat runs as the run that started it, as a real timer's callback does.
   */
  function leaseHeartbeats() {
    const beats: Array<() => void> = [];
    const start = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      beat: () => void,
      everyMs?: number,
    ) => {
      if (everyMs === 60_000) beats.push(AsyncResource.bind(beat));
      return start(beat, everyMs);
    }) as typeof setInterval);
    return () => {
      for (const beat of beats) beat();
    };
  }
  /** Makes a run due in a process, as the code that committed it there would. */
  const wake = (on: ReturnType<typeof startProcess>, run: { id: string }) =>
    runAsSystem("run drain fixture", () => wakeRun(on.jobs, run.id));
  /** Starts a run on a process and waits until its model call is open. */
  async function runInFlight(on: ReturnType<typeof startProcess>, run: { id: string }) {
    await wake(on, run);
    await wait(() => expect(on.turnsOf(run.id)).toHaveLength(1));
    return on.turnsOf(run.id)[0]!;
  }

  it("lets a turn in flight end on the stopping process, which keeps its lease meanwhile", async () => {
    const aMinutePasses = leaseHeartbeats();
    const { createRun } = await seedBot();
    const run = await createRun();
    const leaving = startProcess("leaving", { drains: true });
    const replacement = startProcess("replacement", { drains: false });
    await leaving.start();
    const turn = await runInFlight(leaving, run);
    await replacement.start();

    let stopped = false;
    const stop = leaving.stop().then(() => {
      stopped = true;
    });
    // Both leases are about to run out, and the heartbeat is all that keeps them.
    const soon = new Date(Date.now() + 1_000);
    await system.run.update({ where: { id: run.id }, data: { leaseExpiresAt: soon } });
    await system.computerExecutionLease.updateMany({
      where: { runId: run.id },
      data: { expiresAt: soon },
    });
    aMinutePasses();
    const renewed = Date.now() + 4 * 60_000;
    await wait(async () => {
      expect((await runRow(run.id)).leaseExpiresAt!.getTime()).toBeGreaterThan(renewed);
      const computerLease = await system.computerExecutionLease.findFirstOrThrow({
        where: { runId: run.id },
      });
      expect(computerLease.expiresAt.getTime()).toBeGreaterThan(renewed);
    });
    // The replacement is told the run is ready, as a handoff or its recovery scan would.
    await replacement.continueRun(run.id);
    expect(turn.signal.aborted).toBe(false);
    expect(stopped).toBe(false);
    expect(await runRow(run.id)).toMatchObject({ status: "running", leaseOwner: "leaving" });
    expect(replacement.turnsOf(run.id)).toHaveLength(0);

    turn.finish.resolve();
    await stop;

    expect(await runRow(run.id)).toMatchObject({ status: "completed", error: null, leaseFence: 1 });
    expect(await attemptsOf(run.id)).toEqual([{ fence: 1, status: "completed" }]);
    expect(await repliesOf(run.id)).toBe(1);
    // The model was called once, by the process that was stopping.
    expect(leaving.turnsOf(run.id)).toHaveLength(1);
    expect(replacement.turnsOf(run.id)).toHaveLength(0);
  });

  describe("a turn of several steps", () => {
    const savedTurns = (runId: string) =>
      system.externalEffect.count({ where: { runId, kind: "runtime_checkpoint" } });
    const stepsOf = (on: ReturnType<typeof startProcess>, runId: string) =>
      on.turnsOf(runId).map((turn) => turn.step);
    /** The reply's steps, and the calls later turns replay from its tool history. */
    const replyOf = async (runId: string) => {
      const reply = await system.message.findFirstOrThrow({
        where: { runId, role: "bot" },
        select: { blocks: true, toolHistory: true },
      });
      const blocks = reply.blocks as Array<{ kind: string; steps?: unknown[] }>;
      const history = JSON.parse(reply.toolHistory ?? "null") as ToolHistory | null;
      return {
        steps: blocks.find((block) => block.kind === "steps")?.steps,
        replayed: history?.steps.flatMap((step) => step?.calls.map((call) => call.arguments)),
      };
    };
    const everyStep = {
      steps: [{ label: "List files", count: 3, outcomes: { succeeded: 3 } }],
      replayed: ["step-0", "step-1", "step-2"].map((path) => JSON.stringify({ path })),
    };

    it("is handed back after the step in flight once its process is stopping, and resumes from the next step elsewhere", async () => {
      const { createRun } = await seedBot();
      const run = await createRun();
      const leaving = startProcess("leaving", { drains: true, steps: 3 });
      const replacement = startProcess("replacement", { drains: false, steps: 3 });
      await leaving.start();
      const first = await runInFlight(leaving, run);
      await replacement.start();

      leaving.signalStop();
      first.finish.resolve();
      // The process stops without waiting for the drain limit.
      await leaving.stop();

      await wait(() => expect(stepsOf(replacement, run.id)).toEqual([1]));
      expect(await attemptsOf(run.id)).toEqual([
        { fence: 1, status: "interrupted" },
        { fence: 2, status: "running" },
      ]);
      replacement.turnsOf(run.id)[0]!.finish.resolve();
      await wait(() => expect(stepsOf(replacement, run.id)).toEqual([1, 2]));
      replacement.turnsOf(run.id)[1]!.finish.resolve();
      await wait(async () => expect((await runRow(run.id)).status).toBe("completed"));

      expect(await runRow(run.id)).toMatchObject({
        status: "completed",
        error: null,
        leaseFence: 2,
      });
      expect(await attemptsOf(run.id)).toEqual([
        { fence: 1, status: "interrupted" },
        { fence: 2, status: "completed" },
      ]);
      expect(await repliesOf(run.id)).toBe(1);
      // Each step ran once: the step finished before the stop was not repeated.
      expect(stepsOf(leaving, run.id)).toEqual([0]);
      expect(await savedTurns(run.id)).toBe(0);
      // The step done before the hand-back is in the reply and its history, as if never stopped.
      expect(await replyOf(run.id)).toEqual(everyStep);
    });

    it("goes on in the stopping process when its hand-back fails, keeping the saved turn", async () => {
      const { createRun } = await seedBot();
      const run = await createRun();
      const leaving = startProcess("leaving", { drains: true, steps: 3 });
      await leaving.start();
      const first = await runInFlight(leaving, run);

      workspaceFlush.failNext = true;
      leaving.signalStop();
      first.finish.resolve();

      await wait(() => expect(stepsOf(leaving, run.id)).toEqual([0, 1]));
      expect(workspaceFlush.failNext).toBe(false);
      // Saved before the flush failed, so a cut at the drain limit would not repeat step 0.
      expect(await savedTurns(run.id)).toBe(1);
      expect((await runRow(run.id)).status).toBe("running");
      for (const step of [1, 2]) {
        await wait(() => expect(stepsOf(leaving, run.id)).toContain(step));
        leaving.turnsOf(run.id)[step]!.finish.resolve();
      }
      await wait(async () => expect((await runRow(run.id)).status).toBe("completed"));

      expect(await attemptsOf(run.id)).toEqual([{ fence: 1, status: "completed" }]);
      expect(stepsOf(leaving, run.id)).toEqual([0, 1, 2]);
      expect(await repliesOf(run.id)).toBe(1);
      expect(await replyOf(run.id)).toEqual(everyStep);
    });

    it("resumes a turn a previous release handed back, whose saved turn has no reply", async () => {
      const { createRun } = await seedBot();
      const run = await createRun();
      const leaving = startProcess("leaving", { drains: true, steps: 3 });
      await leaving.start();
      const first = await runInFlight(leaving, run);
      leaving.signalStop();
      first.finish.resolve();
      await leaving.stop();
      const blob = await runAsSystem("run drain fixture", () => loadRunTurnCheckpoint(prisma, run));
      const { reply, ...previousRelease } = JSON.parse(blob!);
      expect(reply).toBeDefined();
      // Stored unencrypted, which the loader also reads, as a release without the reply wrote it.
      await system.externalEffect.updateMany({
        where: { runId: run.id, kind: "runtime_checkpoint" },
        data: { result: JSON.stringify(previousRelease) },
      });

      const replacement = startProcess("replacement", { drains: false, steps: 3 });
      await replacement.start();
      await wake(replacement, run);
      for (const step of [1, 2]) {
        await wait(() => expect(stepsOf(replacement, run.id)).toContain(step));
        replacement.turnsOf(run.id).at(-1)!.finish.resolve();
      }
      await wait(async () => expect((await runRow(run.id)).status).toBe("completed"));

      expect(stepsOf(replacement, run.id)).toEqual([1, 2]);
      expect(await repliesOf(run.id)).toBe(1);
      // Without a saved reply the resumed attempt keeps only its own steps, as before.
      expect(await replyOf(run.id)).toEqual({
        steps: [{ label: "List files", count: 2, outcomes: { succeeded: 2 } }],
        replayed: everyStep.replayed.slice(1),
      });
    });

    it("runs every step in one attempt on a process that is not stopping", async () => {
      const { createRun } = await seedBot();
      const run = await createRun();
      const staying = startProcess("staying", { drains: true, steps: 3 });
      await staying.start();
      await runInFlight(staying, run);
      for (const step of [0, 1, 2]) {
        await wait(() => expect(staying.turnsOf(run.id)).toHaveLength(step + 1));
        staying.turnsOf(run.id)[step]!.finish.resolve();
      }
      await wait(async () => expect((await runRow(run.id)).status).toBe("completed"));

      expect(await attemptsOf(run.id)).toEqual([{ fence: 1, status: "completed" }]);
      expect(stepsOf(staying, run.id)).toEqual([0, 1, 2]);
      expect(await repliesOf(run.id)).toBe(1);
      expect(await savedTurns(run.id)).toBe(0);
      expect(await replyOf(run.id)).toEqual(everyStep);
    });
  });

  it("starts and claims nothing once it is stopping", async () => {
    const busy = await seedBot();
    const other = await seedBot();
    const leaving = startProcess("leaving", { drains: true });
    const replacement = startProcess("replacement", { drains: false });
    await leaving.start();
    await runInFlight(leaving, await busy.createRun());
    leaving.signalStop();

    // A delivery that reaches the executor directly, as a queued job would.
    const delivered = await other.createRun();
    await leaving.continueRun(delivered.id);
    expect(await runRow(delivered.id)).toMatchObject({ status: "queued", leaseOwner: null });
    expect(await attemptsOf(delivered.id)).toEqual([]);

    // A run made due in the stopping process goes to one that is staying.
    await wake(leaving, delivered);
    await replacement.start();
    await wait(() => expect(replacement.turnsOf(delivered.id)).toHaveLength(1));
    expect(await runRow(delivered.id)).toMatchObject({
      status: "running",
      leaseOwner: "replacement",
    });
    expect(leaving.turnsOf(delivered.id)).toHaveLength(0);
  });

  it("hands a turn still running at the drain limit back, and another process resumes it", async () => {
    const { createRun } = await seedBot();
    const run = await createRun();
    const leaving = startProcess("leaving", { drains: true });
    const replacement = startProcess("replacement", { drains: false });
    await leaving.start();
    const turn = await runInFlight(leaving, run);
    await replacement.start();

    // Only the drain limit is on the fake clock; nothing else starts a timer in between.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    leaving.signalStop();
    vi.advanceTimersByTime(RUN_DRAIN_MS - 1);
    expect(turn.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(turn.signal.aborted).toBe(true);
    vi.useRealTimers();
    await leaving.stop();

    await wait(() => expect(replacement.turnsOf(run.id)).toHaveLength(1));
    expect(await attemptsOf(run.id)).toEqual([
      { fence: 1, status: "interrupted" },
      { fence: 2, status: "running" },
    ]);
    replacement.turnsOf(run.id)[0]!.finish.resolve();
    await wait(async () => expect((await runRow(run.id)).status).toBe("completed"));

    expect(await runRow(run.id)).toMatchObject({ status: "completed", error: null, leaseFence: 2 });
    expect(await attemptsOf(run.id)).toEqual([
      { fence: 1, status: "interrupted" },
      { fence: 2, status: "completed" },
    ]);
    expect(await repliesOf(run.id)).toBe(1);
    expect(leaving.turnsOf(run.id)).toHaveLength(1);
  });

  it("leaves the run of a process killed while draining to lease expiry, and refuses its late result", async () => {
    const { createRun } = await seedBot();
    const run = await createRun();
    const killed = startProcess("killed", { drains: true });
    const replacement = startProcess("replacement", { drains: false });
    await killed.start();
    const turn = await runInFlight(killed, run);
    killed.signalStop();
    await replacement.start();

    // While the leases last, the run stays with the process that claimed it.
    await replacement.continueRun(run.id);
    expect(await runRow(run.id)).toMatchObject({ status: "running", leaseOwner: "killed" });

    // A killed process renews nothing, so in time both leases run out.
    const expired = new Date(Date.now() - 1_000);
    await system.run.update({ where: { id: run.id }, data: { leaseExpiresAt: expired } });
    await system.computerExecutionLease.updateMany({
      where: { runId: run.id },
      data: { expiresAt: expired },
    });
    await wait(() => expect(replacement.turnsOf(run.id)).toHaveLength(1));
    replacement.turnsOf(run.id)[0]!.finish.resolve();
    await wait(async () => expect((await runRow(run.id)).status).toBe("completed"));

    // Had the process only stalled, its turn ending now must not complete the run again.
    turn.finish.resolve();
    await killed.stop();
    expect(await runRow(run.id)).toMatchObject({ status: "completed", error: null, leaseFence: 2 });
    expect(await attemptsOf(run.id)).toEqual([
      { fence: 1, status: "interrupted" },
      { fence: 2, status: "completed" },
    ]);
    expect(await repliesOf(run.id)).toBe(1);
  });

  describe.each([
    { state: "running normally", stopping: false },
    { state: "draining", stopping: true },
  ])("a turn that is interrupted while its process is $state", ({ stopping }) => {
    async function turnInFlight() {
      const { createRun } = await seedBot();
      const run = await createRun();
      const first = startProcess("first", { drains: true });
      const second = startProcess("second", { drains: false });
      await first.start();
      const turn = await runInFlight(first, run);
      if (stopping) first.signalStop();
      return { run, first, second, turn };
    }

    it("stops when another process has taken its lease, leaving the run to that process", async () => {
      const { run, turn } = await turnInFlight();
      await system.run.update({
        where: { id: run.id },
        data: { leaseOwner: "usurper", leaseFence: 2 },
      });

      await wait(async () =>
        expect(await attemptsOf(run.id)).toEqual([{ fence: 1, status: "interrupted" }]),
      );
      expect(turn.signal.aborted).toBe(true);
      expect(await runRow(run.id)).toMatchObject({
        status: "running",
        leaseOwner: "usurper",
        leaseFence: 2,
      });
      expect(await repliesOf(run.id)).toBe(0);
    });

    it("stops when its run is cancelled, and the run stays cancelled", async () => {
      const { run, turn } = await turnInFlight();
      await system.$transaction((tx) => cancelRunsInTransaction(tx, [run], new Date()));

      await wait(() => expect(turn.signal.aborted).toBe(true));
      await wait(async () =>
        expect(await system.attempt.count({ where: { runId: run.id, status: "running" } })).toBe(0),
      );
      expect(await runRow(run.id)).toMatchObject({ status: "cancelled", leaseOwner: null });
      expect(await repliesOf(run.id)).toBe(0);
    });

    it("is requeued when the database fails mid-turn, and completes on its next attempt", async () => {
      const { run, first, second, turn } = await turnInFlight();
      // A process running normally starts the run again itself; a draining one leaves it to another.
      if (stopping) await second.start();
      turn.finish.reject(Object.assign(new Error("terminating connection"), { code: "57P01" }));

      const resumedOn = stopping ? second : first;
      await wait(() => expect(resumedOn.turnsOf(run.id)).toHaveLength(stopping ? 1 : 2));
      resumedOn.turnsOf(run.id).at(-1)!.finish.resolve();
      await wait(async () => expect((await runRow(run.id)).status).toBe("completed"));

      expect(await runRow(run.id)).toMatchObject({
        status: "completed",
        error: null,
        leaseFence: 2,
      });
      expect(await attemptsOf(run.id)).toEqual([
        { fence: 1, status: "interrupted" },
        { fence: 2, status: "completed" },
      ]);
      expect(await repliesOf(run.id)).toBe(1);
      expect(first.turnsOf(run.id).length + second.turnsOf(run.id).length).toBe(2);
    });
  });
});
