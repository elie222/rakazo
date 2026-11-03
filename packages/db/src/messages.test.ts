import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import {
  createThreadMessage,
  createThreadMessageInTransaction,
  loadRunHistoryMessages,
  RunHistoryWriteError,
} from "./messages.js";

function transaction() {
  return {
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 1 }) },
    run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
    message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
  };
}

describe("createThreadMessageInTransaction", () => {
  it("allows an automated bot message to opt out of unread without changing the default", async () => {
    const silent = transaction();
    await createThreadMessageInTransaction(silent as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "steps", steps: [{ label: "Checked status", count: 1 }] }],
      markUnread: false,
    });
    expect(silent.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: undefined }) }),
    );

    const visible = transaction();
    await createThreadMessageInTransaction(visible as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "text", text: "Daily report ready" }],
    });
    expect(visible.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: true }) }),
    );
  });

  it("rejects a cancelled run unless the terminal echo opts in", async () => {
    const tx = transaction();
    tx.run.findUnique.mockResolvedValue({ status: "cancelled", startedAt: new Date() });
    const input = {
      threadId: "thread-1",
      role: "bot" as const,
      blocks: [{ kind: "text" as const, text: "Stopped. This stayed queued without starting." }],
      runId: "run-1",
    };
    await expect(
      createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, input),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      ...input,
      allowCancelledRun: true,
    });
    expect(tx.message.create).toHaveBeenCalledOnce();
  });
});

describe("createThreadMessage", () => {
  it("reruns the whole transaction after a mid-write deadlock", async () => {
    const deadlock = Object.assign(new Error("write conflict or a deadlock"), { code: "P2034" });
    const tx = transaction();
    // The sequence already advanced when the insert deadlocks; Postgres rolls both back.
    tx.message.create.mockRejectedValueOnce(deadlock);
    const run = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));

    await expect(
      createThreadMessage({ $transaction: run } as unknown as PrismaClient, {
        threadId: "thread-1",
        role: "bot",
        blocks: [{ kind: "text", text: "Done" }],
      }),
    ).resolves.toEqual({ id: "message-1" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(tx.thread.update).toHaveBeenCalledTimes(2);
    expect(tx.message.create).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors", async () => {
    const run = vi.fn().mockRejectedValue(new Error("unique constraint"));

    await expect(
      createThreadMessage({ $transaction: run } as unknown as PrismaClient, {
        threadId: "thread-1",
        role: "user",
        blocks: [{ kind: "text", text: "hi" }],
      }),
    ).rejects.toThrow("unique constraint");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("loadRunHistoryMessages", () => {
  it("bounds user-triggered history at its source message", async () => {
    const findFirst = vi.fn().mockResolvedValue({ seq: 12 });
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { message: { findFirst, findMany } } as unknown as PrismaClient;

    await loadRunHistoryMessages(
      prisma,
      {
        id: "run-1",
        threadId: "thread-1",
        botId: "bot-1",
        sourceMessageId: "message-12",
        trigger: "user",
      },
      40,
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "message-12", threadId: "thread-1", role: "user" },
      select: { seq: true },
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread-1", seq: { lte: 12 } }),
      }),
    );
  });

  it("does not source-bound scheduled history", async () => {
    const findFirst = vi.fn();
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { message: { findFirst, findMany } } as unknown as PrismaClient;

    await loadRunHistoryMessages(
      prisma,
      {
        id: "run-1",
        threadId: "thread-1",
        botId: "bot-1",
        sourceMessageId: null,
        trigger: "routine",
      },
      40,
    );

    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "thread-1" } }),
    );
  });
});
