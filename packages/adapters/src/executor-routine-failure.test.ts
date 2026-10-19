import { TransientModelError } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

const NOW = new Date("2026-03-02T09:00:00.000Z");
const MINUTE = 60_000;

interface Scenario {
  error: Error;
  trigger?: string;
  retryOfRunId?: string | null;
  routineNotify?: boolean;
  notifyOnFinish?: boolean;
  nextRunAt?: Date | null;
  toolCalls?: number;
  botMessages?: number;
  retryEnqueueFails?: boolean;
}

async function failRun(scenario: Scenario) {
  const trigger = scenario.trigger ?? "routine";
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger,
    routineId: trigger === "routine" ? "routine-1" : null,
    retryOfRunId: scenario.retryOfRunId ?? null,
    leaseFence: 0,
  };
  const runtimeRun = vi.fn(async function* () {
    yield* [];
    throw scenario.error;
  });
  const prisma = {
    user: { findUnique: vi.fn(async () => null) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => ({
        bot: { notifyOnFinish: scenario.notifyOnFinish ?? true },
        thread: { groupId: null },
      })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    routine: {
      findUnique: vi.fn(async () => ({
        notify: scenario.routineNotify ?? true,
        nextRunAt:
          scenario.nextRunAt === undefined
            ? new Date(NOW.getTime() + 24 * 60 * MINUTE)
            : scenario.nextRunAt,
      })),
    },
    event: { count: vi.fn(async () => scenario.toolCalls ?? 0) },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 1,
      })),
    },
    message: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => scenario.botMessages ?? 0),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Sweep the inbox" })) },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    secret: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceBackupModel: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "deepseek/deepseek-v4-flash-0731",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    artifact: { findMany: vi.fn(async () => []) },
  };
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const enqueue = vi.fn(async (job: { name: string }) => {
    if (job.name === "routine.retry" && scenario.retryEnqueueFails) throw new Error("queue down");
  });
  const send = vi.fn(async () => undefined);
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      writeFile: vi.fn(async () => undefined),
      async *exportWorkspace() {
        yield* [];
      },
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get: vi.fn() },
    events: { append: vi.fn(async () => undefined), finalizeRun },
    jobs: { enqueue },
    notifications: { send },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "failed", error: scenario.error.message }),
  );
  const retries = enqueue.mock.calls
    .map(([job]) => job)
    .filter((job) => job.name === "routine.retry");
  return { retries, send };
}

const overloaded = () =>
  new TransientModelError("Our servers are currently overloaded. Please try again later.");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("routine failure notifications", () => {
  it("tells the owner about a failed routine when the routine asks to notify", async () => {
    const { send } = await failRun({
      error: new Error("Invalid API key"),
      routineNotify: true,
      notifyOnFinish: false,
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "failure", title: "Assistant failed" }),
      expect.anything(),
    );
  });

  it("stays quiet about a failed routine that turned notifications off", async () => {
    const { send } = await failRun({
      error: new Error("Invalid API key"),
      routineNotify: false,
      notifyOnFinish: true,
    });

    expect(send).not.toHaveBeenCalled();
  });
});

describe("retrying a routine run after a transient model failure", () => {
  it("schedules one retry and holds the failure notice", async () => {
    const { retries, send } = await failRun({ error: overloaded() });

    expect(retries).toEqual([
      {
        name: "routine.retry",
        payload: { runId: "run-1" },
        availableAt: new Date(NOW.getTime() + 12 * MINUTE),
        replaceKey: "routine.retry:run-1",
      },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["a permanent error", { error: new Error("Invalid API key") }],
    ["a run that was already a retry", { error: overloaded(), retryOfRunId: "run-0" }],
    ["a run that called a tool", { error: overloaded(), toolCalls: 1 }],
    ["a run that posted a message", { error: overloaded(), botMessages: 1 }],
    [
      "a run whose next occurrence is near",
      { error: overloaded(), nextRunAt: new Date(NOW.getTime() + 40 * MINUTE) },
    ],
  ] satisfies Array<[string, Scenario]>)(
    "does not retry %s and notifies instead",
    async (_label, scenario) => {
      const { retries, send } = await failRun(scenario);

      expect(retries).toEqual([]);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "failure" }),
        expect.anything(),
      );
    },
  );

  it("notifies when the retry cannot be queued", async () => {
    const { send } = await failRun({ error: overloaded(), retryEnqueueFails: true });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "failure" }),
      expect.anything(),
    );
  });

  it("does not schedule a routine retry for a chat run", async () => {
    const { retries } = await failRun({ error: overloaded(), trigger: "user" });

    expect(retries).toEqual([]);
  });
});

interface RetryScenario {
  status?: string;
  retryOfRunId?: string | null;
  active?: boolean;
  oneShot?: boolean;
  archived?: boolean;
  nextRunAt?: Date | null;
  laterRun?: boolean;
  laterRunBeforeCreate?: boolean;
  duplicate?: boolean;
  enqueueFails?: boolean;
  routineNotify?: boolean;
  missingRoutine?: boolean;
  missingTask?: boolean;
  pausedBeforeCreate?: boolean;
  archivedBeforeCreate?: boolean;
  invalidDestination?: boolean;
  retryStartedBeforeCleanup?: boolean;
}

function retryHarness(scenario: RetryScenario = {}) {
  const failedAt = new Date(NOW.getTime() - 12 * MINUTE);
  const failed = {
    id: "run-1",
    spaceId: "space-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    userId: "user-1",
    status: scenario.status ?? "failed",
    trigger: "routine",
    routineId: "routine-1",
    retryOfRunId: scenario.retryOfRunId ?? null,
    modelProvider: "routine-provider",
    modelId: "routine-model",
    thinkingLevel: "low",
    modelPinned: true,
    createdAt: failedAt,
    error: overloaded().message,
  };
  const tx = {
    routine: {
      updateMany: vi.fn(async () => ({
        count: scenario.pausedBeforeCreate || scenario.archivedBeforeCreate ? 0 : 1,
      })),
    },
    thread: {
      findFirst: vi.fn(async () => (scenario.invalidDestination ? null : { id: "thread-1" })),
    },
    task: {
      create: vi.fn(async () => ({ id: "task-2" })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    run: {
      findFirst: vi.fn(async () => (scenario.laterRunBeforeCreate ? { id: "run-later" } : null)),
      deleteMany: vi.fn(async () => ({ count: scenario.retryStartedBeforeCleanup ? 0 : 1 })),
      create: vi.fn(async () => {
        if (scenario.duplicate) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        return { id: "run-2", taskId: "task-2" };
      }),
    },
  };
  const prisma = {
    user: { findUnique: vi.fn(async () => null) },
    run: {
      findUnique: vi.fn(async () => failed),
      findFirst: vi.fn(async ({ select }: { select: { id?: boolean } }) =>
        select.id
          ? scenario.laterRun ||
            (scenario.laterRunBeforeCreate && prisma.$transaction.mock.calls.length > 0)
            ? { id: "run-later" }
            : null
          : { bot: { notifyOnFinish: true }, thread: { groupId: null } },
      ),
    },
    routine: {
      findUnique: vi.fn(async () =>
        scenario.missingRoutine
          ? null
          : {
              notify: scenario.routineNotify ?? true,
              active: scenario.active ?? true,
              crons: scenario.oneShot ? ["@once"] : ["0 9 * * *"],
              nextRunAt:
                scenario.nextRunAt === undefined
                  ? new Date(NOW.getTime() + 24 * 60 * MINUTE)
                  : scenario.nextRunAt,
              bot: { archivedAt: scenario.archived ? failedAt : null },
            },
      ),
    },
    task: {
      findUnique: vi.fn(async () => (scenario.missingTask ? null : { prompt: "Sweep the inbox" })),
    },
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    bot: { findUniqueOrThrow: vi.fn(async () => ({ name: "Assistant" })) },
  };
  const enqueue = vi.fn(async () => {
    if (scenario.enqueueFails) throw new Error("queue down");
  });
  const send = vi.fn(async () => undefined);
  const executor = createRunExecutor({
    prisma,
    jobs: { enqueue },
    notifications: { send },
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return { executor, prisma, tx, enqueue, send };
}

describe("running a routine retry", () => {
  it.each(["preference lookup", "delivery"])(
    "propagates abandoned retry %s failures so the job can retry the notice",
    async (failure) => {
      const { executor, prisma, send, enqueue } = retryHarness({ active: false });
      const error = new Error("temporarily unavailable");
      if (failure === "preference lookup") {
        prisma.routine.findUnique.mockResolvedValueOnce({
          notify: true,
          active: false,
          crons: ["0 9 * * *"],
          nextRunAt: null,
          bot: { archivedAt: null },
        });
        prisma.routine.findUnique.mockRejectedValueOnce(error);
      }
      if (failure === "delivery") send.mockRejectedValueOnce(error);

      await expect(executor.retryRoutineRun("run-1")).rejects.toThrow(error);
      await executor.retryRoutineRun("run-1");

      expect(send).toHaveBeenCalledTimes(failure === "delivery" ? 2 : 1);
      expect(enqueue).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["paused", { active: false }],
    ["archived", { archived: true }],
    ["missing its routine", { missingRoutine: true }],
    ["missing its task", { missingTask: true }],
  ] satisfies Array<[string, RetryScenario]>)(
    "notifies when the retry is abandoned because it is %s",
    async (_label, scenario) => {
      const { executor, send, prisma } = retryHarness(scenario);

      await executor.retryRoutineRun("run-1");

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledExactlyOnceWith(
        {
          kind: "failure",
          title: "Assistant failed",
          body: overloaded().message,
          botId: "bot-1",
          threadId: "thread-1",
        },
        expect.objectContaining({ userId: "user-1" }),
      );
    },
  );

  it("respects the routine's notification preference when a paused retry is abandoned", async () => {
    const { executor, send } = retryHarness({ active: false, routineNotify: false });

    await executor.retryRoutineRun("run-1");

    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["a later run exists", { laterRun: true }],
    ["a later run exists for a paused routine", { laterRun: true, active: false }],
    ["the retry was already created", { duplicate: true }],
  ] satisfies Array<[string, RetryScenario]>)(
    "does not notify when %s",
    async (_label, scenario) => {
      const { executor, send } = retryHarness(scenario);

      await executor.retryRoutineRun("run-1");

      expect(send).not.toHaveBeenCalled();
    },
  );

  it("releases the held notice when delivery puts the next occurrence inside the window", async () => {
    const { executor, tx, send } = retryHarness({
      nextRunAt: new Date(NOW.getTime() + 33 * MINUTE),
    });
    vi.setSystemTime(new Date(NOW.getTime() + 4 * MINUTE));

    await executor.retryRoutineRun("run-1");

    expect(tx.task.create).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "failure" }),
      expect.anything(),
    );
  });

  it.each([
    ["paused", { pausedBeforeCreate: true }],
    ["archived", { archivedBeforeCreate: true }],
  ] satisfies Array<[string, RetryScenario]>)(
    "rechecks eligibility when the routine is %s before creation",
    async (_label, scenario) => {
      const { executor, tx, enqueue, send } = retryHarness(scenario);

      await executor.retryRoutineRun("run-1");

      expect(tx.routine.updateMany).toHaveBeenCalledWith({
        where: { id: "routine-1", active: true, bot: { archivedAt: null } },
        data: { active: true },
      });
      expect(tx.task.create).not.toHaveBeenCalled();
      expect(tx.run.create).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledOnce();
    },
  );

  it("abandons a retry whose destination is no longer eligible", async () => {
    const { executor, tx, enqueue, send } = retryHarness({ invalidDestination: true });

    await executor.retryRoutineRun("run-1");

    expect(tx.thread.findFirst).toHaveBeenCalledWith({
      where: {
        id: "thread-1",
        spaceId: "space-1",
        OR: [
          { botId: "bot-1" },
          { group: { archivedAt: null, members: { some: { botId: "bot-1" } } } },
        ],
      },
      select: { id: true },
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("skips creation and notification when a later run appears before the claim", async () => {
    const { executor, tx, enqueue, send } = retryHarness({ laterRunBeforeCreate: true });

    await executor.retryRoutineRun("run-1");

    expect(tx.run.findFirst).toHaveBeenCalledWith({
      where: {
        routineId: "routine-1",
        createdAt: { gt: new Date(NOW.getTime() - 12 * MINUTE) },
      },
      select: { id: true },
    });
    expect(tx.routine.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.run.findFirst.mock.invocationCallOrder[0]!,
    );
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("queues one new run of the routine that points at the failed run", async () => {
    const { executor, tx, enqueue } = retryHarness();

    await executor.retryRoutineRun("run-1");

    expect(tx.task.create).toHaveBeenCalledWith({
      data: {
        spaceId: "space-1",
        botId: "bot-1",
        threadId: "thread-1",
        userId: "user-1",
        prompt: "Sweep the inbox",
        status: "queued",
      },
    });
    expect(tx.run.create).toHaveBeenCalledWith({
      data: {
        spaceId: "space-1",
        botId: "bot-1",
        threadId: "thread-1",
        taskId: "task-2",
        userId: "user-1",
        status: "queued",
        trigger: "routine",
        routineId: "routine-1",
        retryOfRunId: "run-1",
        modelProvider: "routine-provider",
        modelId: "routine-model",
        thinkingLevel: "low",
        modelPinned: true,
      },
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith({
      name: "run.continue",
      payload: { runId: "run-2" },
      replaceKey: "run:run-2",
    });
  });

  it.each([
    ["the run did not fail", { status: "completed" }],
    ["the run was itself a retry", { retryOfRunId: "run-0" }],
    ["the routine was paused", { active: false }],
    ["the bot was archived", { archived: true }],
    ["the next occurrence is near", { nextRunAt: new Date(NOW.getTime() + 20 * MINUTE) }],
    ["a later run of the routine already happened", { laterRun: true }],
  ] satisfies Array<[string, RetryScenario]>)(
    "skips the retry when %s",
    async (_label, scenario) => {
      const { executor, prisma, enqueue } = retryHarness(scenario);

      await executor.retryRoutineRun("run-1");

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it("retries a one-time routine, which turns itself off when it fires", async () => {
    const { executor, tx, enqueue } = retryHarness({
      active: false,
      oneShot: true,
      nextRunAt: null,
    });

    await executor.retryRoutineRun("run-1");

    expect(tx.routine.updateMany).toHaveBeenCalledWith({
      where: {
        id: "routine-1",
        active: false,
        crons: { equals: ["@once"] },
        bot: { archivedAt: null },
      },
      data: { active: false },
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("treats a duplicate retry as already done", async () => {
    const { executor, enqueue } = retryHarness({ duplicate: true });

    await expect(executor.retryRoutineRun("run-1")).resolves.toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("removes the queued retry when it cannot be handed to the job queue", async () => {
    const { executor, prisma, tx } = retryHarness({ enqueueFails: true });

    await expect(executor.retryRoutineRun("run-1")).rejects.toThrow("queue down");
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.run.deleteMany).toHaveBeenCalledWith({
      where: { id: "run-2", status: "queued" },
    });
    expect(tx.task.deleteMany).toHaveBeenCalledWith({
      where: { id: "task-2", status: "queued" },
    });
  });

  it("preserves the task when reconciliation started the retry before enqueue failed", async () => {
    const { executor, prisma, tx } = retryHarness({
      enqueueFails: true,
      retryStartedBeforeCleanup: true,
    });

    await expect(executor.retryRoutineRun("run-1")).rejects.toThrow("queue down");

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.run.deleteMany).toHaveBeenCalledWith({
      where: { id: "run-2", status: "queued" },
    });
    expect(tx.task.deleteMany).not.toHaveBeenCalled();
  });
});

describe("exhausted routine retry notification", () => {
  it.each(["run lookup", "preference lookup", "delivery"])(
    "propagates %s failures so reconciliation retains the notice",
    async (failure) => {
      const { executor, prisma, send } = retryHarness();
      const error = new Error("temporarily unavailable");
      if (failure === "run lookup") prisma.run.findUnique.mockRejectedValueOnce(error);
      if (failure === "preference lookup") prisma.routine.findUnique.mockRejectedValueOnce(error);
      if (failure === "delivery") send.mockRejectedValueOnce(error);

      await expect(executor.notifyRoutineRetryAttemptsExhausted("run-1")).rejects.toThrow(error);
      await executor.notifyRoutineRetryAttemptsExhausted("run-1");
      expect(send).toHaveBeenCalledTimes(failure === "delivery" ? 2 : 1);
    },
  );

  it("does not notify when reconciliation started the retry before enqueue failed", async () => {
    const { executor, prisma, send } = retryHarness({
      enqueueFails: true,
      retryStartedBeforeCleanup: true,
    });

    await expect(executor.retryRoutineRun("run-1")).rejects.toThrow("queue down");
    prisma.run.findFirst.mockResolvedValueOnce({ id: "run-2" });

    await executor.notifyRoutineRetryAttemptsExhausted("run-1");

    expect(prisma.run.findFirst).toHaveBeenLastCalledWith({
      where: {
        OR: [
          { retryOfRunId: "run-1" },
          { routineId: "routine-1", createdAt: { gt: new Date(NOW.getTime() - 12 * MINUTE) } },
        ],
      },
      select: { id: true },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not notify when a later run of the routine exists", async () => {
    const { executor, send } = retryHarness({ laterRun: true });

    await executor.notifyRoutineRetryAttemptsExhausted("run-1");

    expect(send).not.toHaveBeenCalled();
  });

  it("sends the original failure notice after enqueue cleanup", async () => {
    const { executor, send } = retryHarness({ enqueueFails: true });

    await expect(executor.retryRoutineRun("run-1")).rejects.toThrow("queue down");
    expect(send).not.toHaveBeenCalled();
    await executor.notifyRoutineRetryAttemptsExhausted("run-1");

    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: "failure",
        title: "Assistant failed",
        body: overloaded().message.slice(0, 180),
        botId: "bot-1",
        threadId: "thread-1",
      }),
      expect.anything(),
    );
  });

  it("respects the routine's notification preference", async () => {
    const { executor, send } = retryHarness({ routineNotify: false });

    await executor.notifyRoutineRetryAttemptsExhausted("run-1");

    expect(send).not.toHaveBeenCalled();
  });

  it("ignores a missing original run", async () => {
    const { executor, prisma, send } = retryHarness();
    prisma.run.findUnique.mockResolvedValueOnce(null as never);

    await executor.notifyRoutineRetryAttemptsExhausted("run-1");

    expect(send).not.toHaveBeenCalled();
  });

  it.each([{ status: "completed" }, { retryOfRunId: "run-0" }])(
    "ignores an ineligible original run: %s",
    async (scenario) => {
      const { executor, send } = retryHarness(scenario);

      await executor.notifyRoutineRetryAttemptsExhausted("run-1");

      expect(send).not.toHaveBeenCalled();
    },
  );
});
