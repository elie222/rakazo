import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  answerRunInput,
  appendEvent,
  clearThread,
  finalizeComputerControlRelease,
  followThreadEvents,
  pauseRunForInput,
  sendUserMessage,
} from "./events.js";
import { RunHistoryWriteError } from "./messages.js";

class TestFanout implements RealtimeFanout {
  subscriber: ((payload: string) => void) | undefined;
  unsubscribed = false;

  describe() {
    return {
      id: "test",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { distributed: false, push: true },
    };
  }

  async publish(_topic: string, payload: string) {
    this.subscriber?.(payload);
  }

  async subscribe(_topic: string, subscriber: (payload: string) => void) {
    this.subscriber = subscriber;
    return async () => {
      this.unsubscribed = true;
      this.subscriber = undefined;
    };
  }

  async close() {}
}

function event(seq: number) {
  return {
    id: `event-${seq}`,
    workspaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq,
    type: "run.started",
    payload: {},
    runId: null,
    createdAt: new Date("2026-08-15T12:00:00.000Z"),
  };
}

describe("followThreadEvents", () => {
  it("does not lose a notification that arrives while querying", async () => {
    const fanout = new TestFanout();
    const findMany = vi
      .fn()
      .mockImplementationOnce(async () => {
        await fanout.publish("thread:thread-1", "wake");
        return [];
      })
      .mockResolvedValueOnce([event(0)])
      .mockResolvedValue([]);
    const prisma = { event: { findMany } } as unknown as PrismaClient;
    const abort = new AbortController();
    const stream = followThreadEvents(prisma, "thread-1", -1, fanout, abort.signal, 10_000);

    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 0 }, done: false });
    expect(findMany).toHaveBeenCalledTimes(2);
    abort.abort();
    await stream.return(undefined);
    expect(fanout.unsubscribed).toBe(true);
  });

  it("periodically catches up when a signal is missed", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([event(0)]);
    const prisma = { event: { findMany } } as unknown as PrismaClient;
    const abort = new AbortController();
    const stream = followThreadEvents(prisma, "thread-1", -1, undefined, abort.signal, 1);

    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 0 }, done: false });
    abort.abort();
    await stream.return(undefined);
  });
});

describe("finalizeComputerControlRelease", () => {
  it("clears the matching lease and appends its release event in one transaction", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          computerId: "computer-1",
          thread: { id: "thread-1" },
        }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      event: {
        create: vi.fn().mockResolvedValue({
          ...event(7),
          type: "computer.takeover.released",
          payload: { holder: "none", leaseId: "lease-1", reason: "expired" },
        }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      finalizeComputerControlRelease(
        prisma,
        {
          workspaceId: "workspace-1",
          computerId: "computer-1",
          botId: "bot-1",
          leaseId: "lease-1",
          holder: "none",
          reason: "expired",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: {
        id: "computer-1",
        workspaceId: "workspace-1",
        controlBotId: "bot-1",
        controlLeaseId: "lease-1",
      },
      data: {
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
      },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "computer.takeover.released",
          payload: { holder: "none", leaseId: "lease-1", reason: "expired" },
        }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 7 }));
  });

  it("clears the lease even if its controlling bot was deleted", async () => {
    const tx = {
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      bot: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      finalizeComputerControlRelease(prisma, {
        workspaceId: "workspace-1",
        computerId: "computer-1",
        botId: "deleted-bot",
        leaseId: "lease-1",
        holder: "none",
        reason: "expired",
      }),
    ).resolves.toBe(true);

    expect(tx.computer.updateMany).toHaveBeenCalledOnce();
  });
});

describe("pauseRunForInput", () => {
  it("stores the paused run, prompt, and status event in one transaction", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "running",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 4 })
          .mockResolvedValueOnce({ nextEventSeq: 8 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      pauseRunForInput(
        prisma,
        {
          workspaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          runId: "run-1",
          attemptId: "attempt-1",
          leaseOwner: "worker-1",
          leaseFence: 3,
          blocks: [{ kind: "ask", text: "Which city?" }],
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "running", leaseFence: 3 }),
        data: { status: "waiting_input", leaseOwner: null, leaseExpiresAt: null },
      }),
    );
    expect(tx.event.create.mock.calls.map(([input]) => input.data.type)).toEqual([
      "thread.message.created",
      "run.waiting_input",
    ]);
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 8 }));
  });
});

describe("answerRunInput", () => {
  it("answers only the selected pending prompt and publishes its update", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    publish.mockRejectedValueOnce(new Error("realtime unavailable"));
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [{ kind: "ask", text: "Which city?", status: "pending" }],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "queued",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          workspaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answer: "Paris",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "waiting_input" }),
        data: { status: "queued" },
      }),
    );
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [{ kind: "ask", text: "Which city?", status: "answered", answer: "Paris" }],
      },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "thread.message.updated", botId: "bot-2" }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 9 }));
  });

  it("rejects an already answered prompt without queuing the run", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [{ kind: "ask", text: "Which city?", status: "answered", answer: "Paris" }],
        }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        workspaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answer: "Rome",
      }),
    ).resolves.toBe(false);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });
});

describe("sendUserMessage", () => {
  it("creates the message, run, and event in one transaction and publishes once", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn(),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      run: {
        create: vi.fn().mockResolvedValue({ id: "run-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
          runId: "run-1",
        })),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      sendUserMessage(
        prisma,
        {
          workspaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          userId: "user-1",
          blocks: [{ kind: "text", text: "hello" }],
          prompt: "hello",
          trigger: "user",
          clientNonce: "nonce-1",
          linkMessageToRun: true,
        },
        fanout,
      ),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: "task-1", runId: "run-1" });

    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trigger: "user",
          clientNonce: "send:message-1",
          sourceMessageId: "message-1",
        }),
      }),
    );
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: { runId: "run-1" },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "thread.message.created", runId: "run-1" }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 8 }));
  });

  it("skips run creation when the bot is already busy and onlyIfIdle is set", async () => {
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn(),
      },
      task: { create: vi.fn() },
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "run-0" }),
        create: vi.fn(),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      sendUserMessage(prisma, {
        workspaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text: "hello" }],
        prompt: "hello",
        trigger: "follow_up",
        onlyIfIdle: true,
      }),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: null, runId: null });

    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
  });
});

describe("clearThread", () => {
  it("releases the computer execution lease without dropping the computer", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 42, historyCompactionGeneration: 0 })
          .mockResolvedValue({ nextEventSeq: 1 }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]),
        updateMany: vi.fn(),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      computerExecutionLease: { deleteMany: vi.fn() },
      computer: { updateMany: vi.fn() },
      message: { deleteMany: vi.fn() },
      event: {
        deleteMany: vi.fn(),
        create: vi.fn().mockResolvedValue({
          ...event(0),
          type: "thread.cleared",
        }),
      },
      bot: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      clearThread(
        prisma,
        { workspaceId: "workspace-1", threadId: "thread-1", botId: "bot-1" },
        fanout,
      ),
    ).resolves.toMatchObject({
      event: { type: "thread.cleared" },
      cancelledRunIds: ["run-1"],
    });
    expect(tx.computerExecutionLease.deleteMany).toHaveBeenCalledWith({
      where: { botId: "bot-1" },
    });
    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: { executionBotId: "bot-1" },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    // Every deleted message counts as compacted, so compaction cannot summarize cleared history.
    expect(tx.thread.update).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: {
        historyCompactedUpToSeq: 41,
        historyCompactionSummary: null,
        historyCompactionGeneration: { increment: 1 },
      },
    });
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 0 }));
  });
});

describe("appendEvent", () => {
  it("does not persist output from a cancelled run after history was cleared", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }) },
      event: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      appendEvent(
        prisma,
        {
          workspaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          type: "thread.progress",
          runId: "run-1",
          payload: { text: "stale" },
        },
        fanout,
      ),
    ).rejects.toThrow(RunHistoryWriteError);
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("lets a new active run write after the thread was cleared", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const created = {
      ...event(8),
      type: "thread.progress",
      runId: "run-2",
    };
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 9 }) },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
      event: { create: vi.fn().mockResolvedValue(created) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      appendEvent(
        prisma,
        {
          workspaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          type: "thread.progress",
          runId: "run-2",
          payload: { text: "fresh" },
        },
        fanout,
      ),
    ).resolves.toMatchObject({ type: "thread.progress", runId: "run-2" });
    expect(tx.event.create).toHaveBeenCalled();
    expect(publish).toHaveBeenCalled();
  });
});
