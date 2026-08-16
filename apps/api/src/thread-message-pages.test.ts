import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { loadAllMessages, loadMessagePage } from "./thread-message-pages.js";

describe("thread message pages", () => {
  it("queries before the cursor and returns an ascending bounded page", async () => {
    const findMany = vi.fn(async () =>
      [5, 4, 3].map((seq) => ({
        id: `message-${seq}`,
        threadId: "thread-1",
        seq,
        role: "bot",
        blocks: [{ kind: "text", text: String(seq) }],
        runId: null,
        createdAt: new Date(`2026-08-16T00:00:0${seq}.000Z`),
      })),
    );
    const prisma = { message: { findMany } } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", 6, 2);

    expect(findMany).toHaveBeenCalledWith({
      where: { threadId: "thread-1", seq: { lt: 6 } },
      orderBy: { seq: "desc" },
      take: 3,
    });
    expect(page.messages.map((message) => message.seq)).toEqual([4, 5]);
    expect(page.olderCursor).toBe(4);
  });

  it("ends pagination when the database returns no lookahead row", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-0",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        blocks: [],
        runId: null,
        createdAt: new Date("2026-08-16T00:00:00.000Z"),
      },
    ]);
    const prisma = { message: { findMany } } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", 1, 2);

    expect(page.messages.map((message) => message.seq)).toEqual([0]);
    expect(page.olderCursor).toBeNull();
  });

  it("collects bounded pages into chronological export order", async () => {
    const row = (seq: number) => ({
      id: `message-${seq}`,
      threadId: "thread-1",
      seq,
      role: "bot",
      blocks: [],
      runId: null,
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
    });
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([row(4), row(3), row(2)])
      .mockResolvedValueOnce([row(2), row(1), row(0)])
      .mockResolvedValueOnce([row(0)]);
    const prisma = { message: { findMany } } as unknown as PrismaClient;

    const messages = await loadAllMessages(prisma, "thread-1", 2);

    expect(messages.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(findMany.mock.calls.map(([query]) => query.where.seq?.lt)).toEqual([undefined, 3, 1]);
  });
});
