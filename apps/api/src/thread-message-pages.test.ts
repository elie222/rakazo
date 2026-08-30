import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { isPeerRun, loadAllMessages, loadMessagePage } from "./thread-message-pages.js";

describe("thread message pages", () => {
  it("caches peer-run classification for live events", async () => {
    const findUnique = vi.fn(async () => ({ trigger: "bot_message" }));
    const prisma = { run: { findUnique } } as unknown as PrismaClient;
    const cache = new Map<string, Promise<boolean>>();

    await expect(isPeerRun(prisma, "run-peer", cache)).resolves.toBe(true);
    await expect(isPeerRun(prisma, "run-peer", cache)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("filters peer-run output when its receipt is outside the loaded page", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-peer",
        threadId: "thread-1",
        seq: 2,
        role: "bot",
        blocks: [{ kind: "text", text: "Echoed peer reply" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:02.000Z"),
      },
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ]);
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [{ id: "run-peer" }]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages.map((message) => message.id)).toEqual(["message-user"]);
  });

  it("returns peer-run output for the dedicated bot messages view", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-peer",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Peer reply" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ]);
    const prisma = { message: { findMany } } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2, undefined, true);

    expect(page.messages.map((message) => message.id)).toEqual(["message-peer"]);
  });

  it("scans past a page containing only peer-run output", async () => {
    const row = (seq: number, runId: string) => ({
      id: `message-${seq}`,
      threadId: "thread-1",
      seq,
      role: "bot",
      blocks: [{ kind: "text", text: String(seq) }],
      botId: "bot-1",
      replyToMessageId: null,
      runId,
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
    });
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([row(4, "run-peer"), row(3, "run-peer"), row(2, "run-peer")])
      .mockResolvedValueOnce([row(1, "run-user")]);
    const prisma = {
      message: { findMany },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: "run-peer" }])
          .mockResolvedValueOnce([]),
      },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages.map((message) => message.id)).toEqual(["message-1"]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

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

  it("loads a page around a target sequence", async () => {
    const findFirst = vi.fn(async () => ({ seq: 5 }));
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "message-3",
          threadId: "thread-1",
          seq: 3,
          role: "bot",
          blocks: [],
          runId: null,
          createdAt: new Date(),
        },
        {
          id: "message-4",
          threadId: "thread-1",
          seq: 4,
          role: "bot",
          blocks: [],
          runId: null,
          createdAt: new Date(),
        },
        {
          id: "message-5",
          threadId: "thread-1",
          seq: 5,
          role: "bot",
          blocks: [],
          runId: null,
          createdAt: new Date(),
        },
      ])
      .mockResolvedValueOnce(1);
    const count = vi.fn(async () => 1);
    const prisma = {
      message: { findFirst, findMany, count },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 4, { seq: 5 });

    expect(page.messages.map((message) => message.seq)).toEqual([3, 4, 5]);
    expect(page.olderCursor).toBe(3);
    expect(findMany).toHaveBeenCalledWith({
      where: { threadId: "thread-1", seq: { gte: 3, lte: 7 } },
      orderBy: { seq: "asc" },
      take: 4,
    });
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
