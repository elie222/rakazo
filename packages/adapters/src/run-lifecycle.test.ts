import { runContinueJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { returnHelperOutcome } from "./background-helpers.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { failRunBeforeTurn, startNextWaitingRun } from "./run-lifecycle.js";
import { notifyRun } from "./run-notifications.js";

vi.mock("./run-notifications.js", () => ({ notifyRun: vi.fn(async () => undefined) }));
vi.mock("./background-helpers.js", () => ({ returnHelperOutcome: vi.fn(async () => undefined) }));

const UNATTENDED = ["bot_message", "routine", "reaction"];

/** The oldest due run of each kind waiting for the bot's computer. */
function deps(waiting: { attended?: string; unattended?: string }) {
  const findFirst = vi.fn(async (query: { where: { trigger: { notIn?: string[] } } }) => {
    const id = query.where.trigger.notIn ? waiting.attended : waiting.unattended;
    return id ? { id } : null;
  });
  const enqueue = vi.fn(async () => undefined);
  return {
    deps: { prisma: { run: { findFirst } }, jobs: { enqueue } } as unknown as ExecutorDeps,
    findFirst,
    enqueue,
  };
}

function oldestDue(trigger: { in: string[] } | { notIn: string[] }, now: Date) {
  return {
    where: {
      botId: "bot",
      status: "queued",
      id: { not: "finished" },
      trigger,
      OR: [{ wakeAt: null }, { wakeAt: { lte: now } }],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  };
}

describe("starting the next run waiting for a bot's computer", () => {
  it("starts a person's waiting run ahead of bot messages and routines", async () => {
    const now = new Date("2026-10-28T12:00:00Z");
    vi.useFakeTimers({ now });
    try {
      const f = deps({ attended: "chat", unattended: "older-peer-message" });
      await startNextWaitingRun(f.deps, "bot", "finished");
      expect(f.findFirst).toHaveBeenCalledExactlyOnceWith(oldestDue({ notIn: UNATTENDED }, now));
      expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("chat"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the oldest other due run when no person is waiting, leaving failure backoff alone", async () => {
    const now = new Date("2026-10-28T12:00:00Z");
    vi.useFakeTimers({ now });
    try {
      const f = deps({ unattended: "peer-message" });
      await startNextWaitingRun(f.deps, "bot", "finished");
      expect(f.findFirst).toHaveBeenLastCalledWith(oldestDue({ in: UNATTENDED }, now));
      expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("peer-message"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing when no run is waiting", async () => {
    const f = deps({});
    await startNextWaitingRun(f.deps, "bot", "finished");
    expect(f.enqueue).not.toHaveBeenCalled();
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
