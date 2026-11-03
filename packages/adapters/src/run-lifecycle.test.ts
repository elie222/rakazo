import { runContinueJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { failRunBeforeTurn, startNextWaitingRun } from "./run-lifecycle.js";

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

it.each([false, true])(
  "preserves user-facing peer reply unread policy before a turn (%s)",
  async (userFacingPeerReply) => {
    const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
    const deps = {
      events: { finalizeRun },
      prisma: {
        run: { updateMany: vi.fn(async () => ({ count: 1 })), findFirst: vi.fn(async () => null) },
      },
    } as unknown as ExecutorDeps;
    await expect(
      failRunBeforeTurn(
        deps,
        {
          id: "run-1",
          spaceId: "space-1",
          userId: "user-1",
          botId: "bot-1",
          threadId: "thread-1",
          taskId: "task-1",
          trigger: "bot_message",
        },
        "Bot",
        { attemptId: "attempt-1", workerId: "worker-1", fence: 1 },
        "Connect that model provider first",
        userFacingPeerReply,
      ),
    ).resolves.toBe(true);
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", markUnread: userFacingPeerReply }),
    );
  },
);
