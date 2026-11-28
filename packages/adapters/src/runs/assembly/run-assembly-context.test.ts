import { describe, expect, it, vi } from "vitest";
import { previousMessageAt } from "./run-assembly-context.js";
import { loadTurnContext } from "./run-assembly-history.js";

describe("previousMessageAt", () => {
  it("takes the newest message other than the current turn, in any order", () => {
    const messages = [
      { id: "now", createdAt: new Date("2026-11-12T08:54:00Z") },
      { id: "b", createdAt: new Date("2026-11-11T21:42:00Z") },
      { id: "a", createdAt: new Date("2026-11-11T21:40:00Z") },
    ];
    expect(previousMessageAt(messages, "now")?.toISOString()).toBe("2026-11-11T21:42:00.000Z");
  });

  it("is undefined for a first message", () => {
    expect(previousMessageAt([{ id: "now", createdAt: new Date() }], "now")).toBe(undefined);
  });
});

describe("loadTurnContext", () => {
  it("redacts run secrets containing XML characters before memory, scratchpad, ticket, and recall formatting", async () => {
    const secret = "cred<x&y>secret";
    const hold = {
      runId: "run-1",
      secrets: [secret],
      run: {
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        trigger: "user",
        sourceMessageId: null,
      },
      deps: {
        now: () => new Date("2026-11-25T12:00:00Z"),
        memory: {
          read: vi.fn(async ({ scope }: { scope: string }) => ({
            documents:
              scope === "bot" ? [{ path: "MEMORY.md", content: `Bot note with ${secret}` }] : [],
          })),
        },
        prisma: {
          message: { findMany: vi.fn(async () => []) },
          scratchpadItem: {
            findMany: vi.fn(async () => [
              {
                id: "s-1",
                key: "note-1",
                title: "Note",
                status: "open",
                notes: `Scratchpad ${secret}`,
                createdAt: new Date("2026-11-25T10:00:00Z"),
                updatedAt: new Date("2026-11-25T11:00:00Z"),
              },
            ]),
            count: vi.fn(async () => 0),
          },
          board: { findUnique: vi.fn(async () => ({ id: "board-1", ticketPrefix: "RAK" })) },
          ticket: {
            findMany: vi.fn(async () => [
              {
                id: "t-1",
                number: 7,
                title: `Title ${secret}`,
                status: "doing",
                assigneeBotId: null,
              },
            ]),
          },
          ticketComment: {
            findMany: vi.fn(async () => [{ ticketId: "t-1", body: `Comment ${secret}` }]),
          },
        },
      },
    } as unknown as Parameters<typeof loadTurnContext>[0];

    const parts = {
      records: {
        bot: { id: "bot-1" },
        messages: [],
        messagingChannelRun: false,
        nonOwnerChatRun: false,
        ownerComputerRoutine: false,
        peerMessage: undefined,
        task: { prompt: "Check RAK-7" },
        thread: { id: "thread-1", historyCompactedUpToSeq: 5, historyCompactionGeneration: 1 },
        conversationThread: { groupId: null },
        ticketBoardEnabled: true,
      },
      connected: {
        context: { spaceId: "space-1", userId: "user-1", botId: "bot-1", runId: "run-1" },
        discoveredPromise: Promise.resolve([]),
        memoryScope: "bot",
        semanticMemory: {
          describe: () => ({ capabilities: { recallEachRun: true } }),
          recall: vi.fn(async () => ({
            ok: true,
            value: [{ memory: `Recalled ${secret}`, external: false, entity: `ent ${secret}` }],
          })),
        },
      },
      thread: {
        compactedHistory: { history: [], usedLocalSummary: false },
        threadContext: { includeSemanticRecall: true },
      },
    } as unknown as Parameters<typeof loadTurnContext>[1];

    const turnContext = await loadTurnContext(hold, parts);
    for (const block of [
      turnContext.memoryContext,
      turnContext.scratchpadContext,
      turnContext.ticketContext,
      turnContext.recalledMemory,
    ]) {
      expect(block).toContain("[redacted]");
      expect(block).not.toContain(secret);
      expect(block).not.toContain("cred&lt;");
      expect(block).not.toContain("x&amp;y");
    }
  });
});
