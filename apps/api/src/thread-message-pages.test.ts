import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  isPeerRun,
  isUserVisiblePeerRunEvent,
  loadAllMessages,
  loadMessagePage,
} from "./thread-message-pages.js";

function peerRun(intent: "request" | "result" = "result") {
  return {
    id: "run-peer",
    sourceMessage: {
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-2",
          fromBotName: "Coder",
          text: intent === "request" ? "Check this." : "Done.",
          intent,
        },
      ],
    },
  };
}

describe("thread message pages", () => {
  it("keeps takeover events visible for peer-triggered runs", () => {
    expect(
      isUserVisiblePeerRunEvent({
        type: "thread.message.created",
        payload: {
          blocks: [{ kind: "computer", state: "Ready", text: "Please complete login." }],
        },
      }),
    ).toBe(true);
    expect(isUserVisiblePeerRunEvent({ type: "computer.takeover.requested", payload: {} })).toBe(
      true,
    );
    expect(
      isUserVisiblePeerRunEvent({
        type: "thread.message.created",
        payload: { blocks: [{ kind: "text", text: "Private worker narration." }] },
      }),
    ).toBe(false);
  });

  it("caches peer-run classification for live events", async () => {
    const findUnique = vi.fn(async () => ({ trigger: "bot_message" }));
    const prisma = { run: { findUnique } } as unknown as PrismaClient;
    const cache = new Map<string, Promise<boolean>>();

    await expect(isPeerRun(prisma, "run-peer", cache)).resolves.toBe(true);
    await expect(isPeerRun(prisma, "run-peer", cache)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("keeps peer receipts and final owner summaries while filtering peer activity", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-reply",
        threadId: "thread-1",
        seq: 3,
        role: "bot",
        blocks: [{ kind: "text", text: "Echoed peer reply" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:03.000Z"),
      },
      {
        id: "message-received",
        threadId: "thread-1",
        seq: 2,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-2",
            fromBotName: "Coder",
            text: "Done.",
          },
        ],
        botId: null,
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
      run: { findMany: vi.fn(async () => [peerRun()]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 3);

    expect(page.messages.map((message) => message.id)).toEqual([
      "message-user",
      "message-received",
      "message-reply",
    ]);
  });

  it("keeps a peer-run owner summary when its receipt is outside the loaded page", async () => {
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
      run: { findMany: vi.fn(async () => [peerRun()]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages.map((message) => message.id)).toEqual(["message-user", "message-peer"]);
  });

  it("hides an assigned worker's final reply from the normal transcript", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-worker-reply",
        threadId: "thread-1",
        seq: 2,
        role: "bot",
        blocks: [{ kind: "text", text: "The check passed." }],
        botId: "bot-worker",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:02.000Z"),
      },
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Older visible answer" }],
        botId: "bot-worker",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ]);
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [peerRun("request")]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages.map((message) => message.id)).toEqual(["message-user"]);
  });

  it("keeps an assigned worker's takeover request in the normal transcript", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-takeover",
        threadId: "thread-1",
        seq: 2,
        role: "bot",
        blocks: [{ kind: "computer", state: "Ready", text: "Please complete the staging login." }],
        botId: "bot-worker",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:02.000Z"),
      },
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Older visible answer" }],
        botId: "bot-worker",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ]);
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [peerRun("request")]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages.map((message) => message.id)).toEqual([
      "message-user",
      "message-takeover",
    ]);
  });

  it("filters mid-turn peer narration identified by its durable nonce", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-progress",
        threadId: "thread-1",
        seq: 2,
        role: "bot",
        blocks: [{ kind: "text", text: "Still checking." }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        clientNonce: "user-progress:run-peer:0:test",
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
        clientNonce: null,
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ]);
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [peerRun()]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages.map((message) => message.id)).toEqual(["message-user"]);
  });

  it("keeps untagged mid-turn peer narration out when a later terminal summary exists", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-summary",
        threadId: "thread-1",
        seq: 3,
        role: "bot",
        blocks: [{ kind: "text", text: "Coder finished the review." }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        clientNonce: null,
        createdAt: new Date("2026-08-16T00:00:03.000Z"),
      },
      {
        id: "message-progress",
        threadId: "thread-1",
        seq: 2,
        role: "bot",
        blocks: [{ kind: "text", text: "Still drafting the report." }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        clientNonce: null,
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
        clientNonce: null,
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ]);
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [peerRun()]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 3);

    expect(page.messages.map((message) => message.id)).toEqual(["message-user", "message-summary"]);
  });

  it("hides paginated peer narration when its terminal summary is on a newer page", async () => {
    const progress = {
      id: "message-progress",
      threadId: "thread-1",
      seq: 2,
      role: "bot",
      blocks: [{ kind: "text", text: "Still drafting the report." }],
      botId: "bot-1",
      replyToMessageId: null,
      runId: "run-peer",
      clientNonce: null,
      createdAt: new Date("2026-08-16T00:00:02.000Z"),
    };
    const summary = {
      ...progress,
      id: "message-summary",
      seq: 3,
      blocks: [{ kind: "text", text: "Coder finished the review." }],
      createdAt: new Date("2026-08-16T00:00:03.000Z"),
    };
    const visible = {
      ...progress,
      id: "message-user",
      seq: 1,
      blocks: [{ kind: "text", text: "Visible answer" }],
      runId: "run-user",
      createdAt: new Date("2026-08-16T00:00:01.000Z"),
    };
    const findMany = vi.fn(async (query: { where?: { runId?: unknown } }) =>
      query.where?.runId ? [progress, summary] : [progress, visible],
    );
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [peerRun()]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", 3, 2);

    expect(page.messages.map((message) => message.id)).toEqual(["message-user"]);
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { runId: { in: ["run-peer"] } } }),
    );
  });

  it("projects mixed peer-run finals down to owner-facing text", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-peer",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [
          { kind: "steps", steps: [{ label: "Message bot", count: 1 }] },
          { kind: "text", text: "Engineer finished the review." },
        ],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        clientNonce: null,
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ]);
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [peerRun()]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages[0]?.blocks).toEqual([
      { kind: "text", text: "Engineer finished the review." },
    ]);
  });

  it("keeps a peer summary around-page target but omits peer activity", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 4,
        role: "bot",
        blocks: [{ kind: "text", text: "Visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:04.000Z"),
      },
      {
        id: "message-peer-activity",
        threadId: "thread-1",
        seq: 5,
        role: "bot",
        blocks: [{ kind: "steps", steps: [{ label: "Message bot", count: 1 }] }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:05.000Z"),
      },
      {
        id: "message-peer-target",
        threadId: "thread-1",
        seq: 6,
        role: "bot",
        blocks: [{ kind: "text", text: "Peer reply" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:06.000Z"),
      },
    ]);
    const count = vi.fn(async () => 1);
    const runFindMany = vi.fn(async () => [peerRun()]);
    const prisma = {
      message: { findMany, count },
      run: { findMany: runFindMany },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 4, {
      messageId: "message-peer-target",
      seq: 6,
    });

    expect(page.messages.map((message) => message.id)).toEqual([
      "message-user",
      "message-peer-target",
    ]);
    expect(runFindMany).toHaveBeenCalled();
  });

  it("keeps peer receipt around-page targets in the normal transcript page", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 4,
        role: "bot",
        blocks: [{ kind: "text", text: "Visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:04.000Z"),
      },
      {
        id: "message-peer-receipt",
        threadId: "thread-1",
        seq: 5,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-2",
            fromBotName: "Coder",
            text: "Done.",
          },
        ],
        botId: null,
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:05.000Z"),
      },
      {
        id: "message-peer-text",
        threadId: "thread-1",
        seq: 6,
        role: "bot",
        blocks: [{ kind: "text", text: "Peer reply" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:06.000Z"),
      },
    ]);
    const count = vi.fn(async () => 0);
    const prisma = {
      message: { findMany, count },
      run: { findMany: vi.fn(async () => [peerRun()]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 4, {
      messageId: "message-peer-receipt",
      seq: 5,
    });

    expect(page.messages.map((message) => message.id)).toEqual([
      "message-user",
      "message-peer-receipt",
      "message-peer-text",
    ]);
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
    const prisma = {
      message: { findMany, count: vi.fn(async () => 0) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(
      prisma,
      "thread-1",
      undefined,
      2,
      { messageId: "message-peer", seq: 1 },
      true,
    );

    expect(page.messages.map((message) => message.id)).toEqual(["message-peer"]);
  });

  it("scans past a page containing only peer-run activity", async () => {
    const row = (seq: number, runId: string) => ({
      id: `message-${seq}`,
      threadId: "thread-1",
      seq,
      role: "bot",
      blocks: [{ kind: "steps", steps: [{ label: String(seq), count: 1 }] }],
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

  it("scans past a receipt-only page so web can reach older user-visible rows", async () => {
    const receiptRows = [
      {
        id: "message-receipt-b",
        threadId: "thread-1",
        seq: 3,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-2",
            fromBotName: "Coder",
            text: "Done.",
          },
        ],
        botId: null,
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:03.000Z"),
      },
      {
        id: "message-receipt-a",
        threadId: "thread-1",
        seq: 2,
        role: "user",
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-2",
            toBotName: "Coder",
            text: "Check this.",
          },
        ],
        botId: null,
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:02.000Z"),
      },
      {
        id: "message-lookahead",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Older visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ];
    const olderRows = [
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Older visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ];
    const findMany = vi.fn().mockResolvedValueOnce(receiptRows).mockResolvedValueOnce(olderRows);
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

    expect(page.messages.map((message) => message.id)).toEqual(["message-user"]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("returns a receipt-only page when the client displays peer receipts", async () => {
    const receipt = (seq: number) => ({
      id: `message-receipt-${seq}`,
      threadId: "thread-1",
      seq,
      role: "user",
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-2",
          fromBotName: "Coder",
          text: "Done.",
        },
      ],
      botId: null,
      replyToMessageId: null,
      runId: "run-peer",
      createdAt: new Date(`2026-08-16T00:00:0${seq}.000Z`),
    });
    const findMany = vi.fn(async () => [receipt(3), receipt(2), receipt(1)]);
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [{ id: "run-peer" }]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2, undefined, false, true);

    expect(page.messages.map((message) => message.id)).toEqual([
      "message-receipt-2",
      "message-receipt-3",
    ]);
    expect(page.olderCursor).toBe(2);
    expect(findMany).toHaveBeenCalledTimes(1);
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
        thumbsUp: seq === 4,
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
    expect(page.messages[0]?.thumbsUp).toBe(true);
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
