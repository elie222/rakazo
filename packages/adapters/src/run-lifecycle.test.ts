import { runContinueJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { returnHelperOutcome } from "./background-helpers.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { failRunBeforeTurn, requeueComputerRun, startNextWaitingRun } from "./run-lifecycle.js";
import { notifyRun } from "./run-notifications.js";

vi.mock("./run-notifications.js", () => ({ notifyRun: vi.fn(async () => undefined) }));
vi.mock("./background-helpers.js", () => ({ returnHelperOutcome: vi.fn(async () => undefined) }));

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
