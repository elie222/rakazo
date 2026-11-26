import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "../assembly/run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { messagingTools } from "./run-tools-messaging.js";

function makeContext(overrides?: { sourceMessageId?: string; secrets?: string[] }) {
  const createdMessages: Array<{ blocks: MessageBlock[]; replyToMessageId?: string }> = [];
  const createdEvents: Array<{ payload: Record<string, unknown> }> = [];
  const ctx = {
    run: {
      id: "run-1",
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      trigger: "user",
      sourceMessageId: overrides?.sourceMessageId ?? "msg-user-1",
    },
    thread: { id: "thread-1" },
    secrets: overrides?.secrets ?? ["super-secret-token"],
    state: {
      reply: {
        publishedMidTurnUserMessage: false,
        openingAckOnly: true,
      },
    },
    deps: {
      prisma: {
        message: {
          findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
            where.id === "msg-custom" ? { id: "msg-custom" } : { id: "msg-latest" },
          ),
        },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            $queryRaw: vi.fn(async () => [{ bypass: null, key: null, login: "test" }]),
            $executeRaw: vi.fn(async () => 0),
            run: {
              findUnique: vi.fn(async () => ({
                id: "run-1",
                status: "running",
                leaseOwner: null,
                leaseFence: 0,
              })),
              updateMany: vi.fn(async () => ({ count: 1 })),
            },
            thread: {
              findUnique: vi.fn(async () => ({
                spaceId: "space-1",
                botId: "bot-1",
                groupId: null,
              })),
              update: vi.fn(async () => ({ nextMessageSeq: 10, nextEventSeq: 20 })),
            },
            spaceMember: {
              findMany: vi.fn(async () => []),
            },
            message: {
              create: vi.fn(
                async ({
                  data,
                }: {
                  data: { blocks: MessageBlock[]; replyToMessageId?: string };
                }) => {
                  createdMessages.push({
                    blocks: data.blocks,
                    replyToMessageId: data.replyToMessageId,
                  });
                  return { id: `msg-${createdMessages.length}`, ...data };
                },
              ),
            },
            event: {
              create: vi.fn(async ({ data }: { data: { payload: Record<string, unknown> } }) => {
                createdEvents.push({ payload: data.payload });
                return { id: `evt-${createdEvents.length}`, seq: createdEvents.length };
              }),
            },
          }),
      },
      events: {
        notify: vi.fn(async () => undefined),
      },
    },
  } as unknown as RunContext;
  return { ctx, createdMessages, createdEvents };
}

function makeCall(args: Record<string, unknown>): ToolCall {
  return {
    name: "test",
    args,
    executionId: "exec-1",
    effectKey: "eff-1",
    finish: async (result: unknown) => result,
  } as unknown as ToolCall;
}

describe("bot react, show_status, and show_cards tools", () => {
  it("reacts to the triggering message with a valid emoji and suppresses empty fallback", async () => {
    const { ctx, createdMessages, createdEvents } = makeContext();
    const result = await messagingTools.react!(ctx, makeCall({ emoji: "👍" }));
    expect(result).toEqual({ ok: true, emoji: "👍", messageId: "msg-user-1" });
    expect(createdMessages).toEqual([
      { blocks: [{ kind: "text", text: "👍" }], replyToMessageId: "msg-user-1" },
    ]);
    expect(createdEvents[0]?.payload).toMatchObject({ replyToMessageId: "msg-user-1" });
    expect(ctx.state.reply.publishedMidTurnUserMessage).toBe(true);
  });

  it("rejects unsupported reaction emojis", async () => {
    const { ctx } = makeContext();
    const result = await messagingTools.react!(ctx, makeCall({ emoji: "hello" }));
    expect(result).toMatchObject({ error: expect.stringContaining("emoji") });
  });

  it("posts a redacted status card through show_status", async () => {
    const { ctx, createdMessages } = makeContext();
    const result = await messagingTools.show_status!(
      ctx,
      makeCall({
        lines: [
          { key: "Flight", value: "AC123" },
          { key: "Token", value: "super-secret-token" },
        ],
      }),
    );
    expect(result).toEqual({ ok: true, count: 2 });
    expect(createdMessages[0]?.blocks).toEqual([
      {
        kind: "card",
        lines: [
          { k: "Flight", v: "AC123" },
          { k: "Token", v: "[redacted]" },
        ],
      },
    ]);
  });

  it("posts sanitized result cards through show_cards and drops non-http URLs", async () => {
    const { ctx, createdMessages } = makeContext();
    const result = await messagingTools.show_cards!(
      ctx,
      makeCall({
        title: "Hotels",
        items: [
          {
            title: "Ace Hotel",
            subtitle: "Downtown",
            price: "$210/night",
            rating: "4.7",
            url: "https://example.com/ace",
            imageUrl: "javascript:alert(1)",
            badges: ["Free cancel"],
          },
        ],
      }),
    );
    expect(result).toEqual({ ok: true, count: 1 });
    expect(createdMessages[0]?.blocks).toEqual([
      {
        kind: "result_cards",
        title: "Hotels",
        items: [
          {
            title: "Ace Hotel",
            subtitle: "Downtown",
            price: "$210/night",
            rating: "4.7",
            url: "https://example.com/ace",
            badges: ["Free cancel"],
          },
        ],
      },
    ]);
  });
});
