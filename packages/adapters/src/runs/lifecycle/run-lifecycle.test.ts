import {
  runContinueJob,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
} from "@rakazo/adapter-kit";
import { databaseOutage } from "@rakazo/db";
import type { TestSink } from "@rakazo/logging";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerBusyError } from "../../computers/computer-lifecycle.js";
import { VaultKeyUnavailableError } from "../../secrets/bot-secrets.js";
import { returnHelperOutcome } from "../../tasks/background-helpers.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import {
  failRunBeforeTurn,
  PausedTurnToolsUnavailableError,
  RUN_SETUP_FAILURE_REASON_MAX,
  requeueComputerRun,
  retryRunSetup,
  startNextWaitingRun,
} from "./run-lifecycle.js";
import { notifyRun } from "./run-notifications.js";

vi.mock("./run-notifications.js", () => ({ notifyRun: vi.fn(async () => undefined) }));
vi.mock("../../tasks/background-helpers.js", () => ({
  returnHelperOutcome: vi.fn(async () => undefined),
}));

function deps(next: { id: string } | null) {
  const findFirst = vi.fn(async () => next);
  const enqueue = vi.fn(async () => undefined);
  return {
    deps: { prisma: { run: { findFirst } }, jobs: { enqueue } } as unknown as ExecutorDeps,
    findFirst,
    enqueue,
  };
}

describe("starting the next run waiting for a bot's computer", () => {
  it("starts the oldest other due run of the bot, leaving failure backoff alone", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T12:00:00Z") });
    try {
      const f = deps({ id: "waiting" });
      await startNextWaitingRun(f.deps, "bot", "finished");
      expect(f.findFirst).toHaveBeenCalledWith({
        where: {
          botId: "bot",
          status: "queued",
          id: { not: "finished" },
          OR: [{ wakeAt: null }, { wakeAt: { lte: new Date("2026-10-28T12:00:00Z") } }],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("waiting"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing when no run is waiting", async () => {
    const f = deps(null);
    await startNextWaitingRun(f.deps, "bot", "finished");
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});

describe("parking a run until its bot's computer is released", () => {
  function parking() {
    // The first write is for a run whose takeover was already answered; none here.
    const updateMany = vi.fn(async () => ({ count: 1 })).mockResolvedValueOnce({ count: 0 });
    const enqueue = vi.fn(async () => undefined);
    return {
      deps: { prisma: { run: { updateMany } }, jobs: { enqueue } } as unknown as ExecutorDeps,
      updateMany,
      enqueue,
    };
  }

  it("leaves the run due for the release, and a takeover wait for its person", async () => {
    const now = new Date("2026-11-01T12:00:00Z");
    vi.useFakeTimers({ now });
    try {
      const queued = parking();
      await requeueComputerRun(queued.deps, "run", "worker", 3, null, false, true);
      expect(queued.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "queued", wakeAt: now }),
        }),
      );
      expect(queued.enqueue).not.toHaveBeenCalled();

      const held = parking();
      await requeueComputerRun(held.deps, "run", "worker", 3, null, true, true);
      expect(held.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "waiting_takeover", wakeAt: null }),
        }),
      );
      expect(held.enqueue).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("failing a run before its turn", () => {
  it("brings a background helper's failure back to its chat instead of pushing a notice", async () => {
    const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
    const deps = { events: { finalizeRun } } as unknown as ExecutorDeps;
    const run = (trigger: string) => ({
      id: `${trigger}-run`,
      spaceId: "space",
      userId: "user",
      botId: "bot",
      threadId: "thread",
      taskId: "task",
      trigger,
    });
    const lease = { attemptId: "attempt", workerId: "worker", fence: 1 };

    await failRunBeforeTurn(deps, run("helper"), "Chief", lease, "model not connected");
    expect(returnHelperOutcome).toHaveBeenCalledExactlyOnceWith(deps, run("helper"), {
      status: "failed",
      text: "model not connected",
    });
    expect(notifyRun).not.toHaveBeenCalled();

    await failRunBeforeTurn(deps, run("user"), "Chief", lease, "model not connected");
    expect(notifyRun).toHaveBeenCalledOnce();
    expect(returnHelperOutcome).toHaveBeenCalledOnce();
  });
});

describe("retrying a run whose setup failed", () => {
  const SECRET = "hunter2-setup-secret";
  const RETRYING = "Run setup failed; retrying";
  const run = {
    id: "run-1",
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    trigger: "user",
  };
  const databaseDown = () => new Error("Connection terminated unexpectedly");
  let sink: TestSink;

  beforeEach(() => {
    sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
  });
  afterEach(() => {
    // The outage is shared by the process; a later test must not start inside this one's.
    databaseOutage.succeeded();
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
  });

  async function retry(setupError: unknown, options: { leaseValid?: boolean } = {}) {
    const requeueRun = vi.fn(async (_: { data: { error: string | null } }) => ({ count: 1 }));
    const recordAttempt = vi.fn(async (_: { data: { status: string; error: string | null } }) => ({
      id: "attempt-1",
    }));
    const priorAttempts = vi.fn(async () => []);
    const deps = {
      prisma: {
        run: { updateMany: requeueRun },
        attempt: { update: recordAttempt, findMany: priorAttempts },
      },
      jobs: { enqueue: vi.fn(async () => undefined) },
    } as unknown as ExecutorDeps;
    await retryRunSetup(
      deps,
      run,
      { id: "attempt-1", workerId: "worker", fence: 2 },
      {
        resumeCheckpoint: null,
        heldForTakeover: false,
        dispatchHandedOff: true,
        leaseValid: options.leaseValid ?? true,
        secrets: [SECRET],
      },
      setupError,
    );
    return {
      attempt: recordAttempt.mock.calls[0]?.[0].data,
      runError: requeueRun.mock.calls[0]?.[0].data.error,
      priorAttempts,
      logged: sink.events.filter((event) => event.message === "run.setup_failed"),
    };
  }

  it("records the redacted reason on the attempt and leaves the run's own text alone", async () => {
    const failed = await retry(new Error(`The model provider rejected the key ${SECRET}`));

    expect(failed.attempt).toMatchObject({
      status: "setup_failed",
      error: "The model provider rejected the key [redacted]",
    });
    expect(failed.runError).toBe(RETRYING);
    expect(failed.priorAttempts).toHaveBeenCalledOnce();
  });

  it("stores no more of a long reason than the limit", async () => {
    const failed = await retry(new Error("x".repeat(RUN_SETUP_FAILURE_REASON_MAX * 3)));

    expect(failed.attempt?.error).toBe("x".repeat(RUN_SETUP_FAILURE_REASON_MAX));
  });

  it.each([
    ["a computer busy with another run", () => new ComputerBusyError()],
    ["a database outage", databaseDown],
  ])("records no reason, counts nothing and stays quiet for %s", async (_name, error) => {
    const waiting = await retry(error());

    expect(waiting.attempt).toMatchObject({ status: "setup_failed", error: null });
    expect(waiting.runError).toBeNull();
    expect(waiting.priorAttempts).not.toHaveBeenCalled();
    expect(waiting.logged).toEqual([]);
  });

  it.each([
    ["an unexpected failure", () => new Error(`boom ${SECRET}`), true, "error"],
    ["a computer that did not start", () => new SandboxUnavailableError(), true, "warn"],
    [
      "an unreachable computer provider",
      () => new SandboxUnresponsiveError(`unreachable ${SECRET}`),
      true,
      "warn",
    ],
    [
      "an unavailable key manager",
      () => new VaultKeyUnavailableError(new Error(`outage ${SECRET}`)),
      true,
      "warn",
    ],
    [
      "a paused turn's tool going offline",
      () => new PausedTurnToolsUnavailableError(),
      true,
      "warn",
    ],
    ["setup a lost lease aborted", () => new Error(`aborted ${SECRET}`), false, "warn"],
  ] as const)("logs %s with the run's fields", async (_name, error, leaseValid, level) => {
    const failure = error();
    const failed = await retry(failure, { leaseValid });

    expect(failed.logged).toEqual([
      expect.objectContaining({
        level,
        "run.id": "run-1",
        "space.id": "space-1",
        "thread.id": "thread-1",
        "bot.id": "bot-1",
        error: expect.objectContaining({ name: failure.name }),
      }),
    ]);
    expect(JSON.stringify(sink.events)).not.toContain(SECRET);
  });
});
