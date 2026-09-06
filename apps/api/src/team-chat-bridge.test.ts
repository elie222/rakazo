import type { TeamChatInboundMessage, TeamChatSendRequest } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  TeamChatBridge,
  teamChatAmbientPrompt,
  teamChatPrompt,
  teamChatResponseText,
} from "./team-chat-bridge.js";

describe("team chat bridge", () => {
  it("attributes an external speaker without changing their message", () => {
    expect(teamChatPrompt("slack", "Ada Lovelace", "Review the launch plan")).toBe(
      "Slack message from Ada Lovelace:\n\nReview the launch plan",
    );
  });

  it("keeps provider IDs out of ambient conversation context", () => {
    const prompt = teamChatAmbientPrompt({
      provider: "slack",
      channelId: "G123",
      channelName: "leadership",
      rules: "Engage on launch risks.",
      messages: [{ senderName: "Pat", senderId: "U123", content: "Launch moved to Friday." }],
    });
    expect(prompt).toContain("Slack channel update from #leadership.");
    expect(prompt).toContain("Pat: Launch moved to Friday.");
    expect(prompt).not.toContain("G123");
    expect(prompt).not.toContain("U123");
  });

  it("returns written agent output without leaking tool or computer blocks", () => {
    const blocks: MessageBlock[] = [
      { kind: "progress", text: "Searching" },
      { kind: "text", text: "The plan is ready." },
      { kind: "meta", text: "internal metadata" },
    ];
    expect(teamChatResponseText(blocks)).toBe("The plan is ready.");
    expect(teamChatResponseText([])).toBe("Bot completed the request without a written reply.");
  });

  it("creates one isolated run and one reply for duplicate provider events", async () => {
    const records: Array<Record<string, unknown>> = [];
    const sendUserMessage = vi.fn(async (input: { createRun?: boolean }) =>
      input.createRun === false
        ? { messageId: "message-visible", seq: 1, taskId: null, runId: null }
        : { messageId: "message-prompt", seq: 2, taskId: "task-1", runId: "run-1" },
    );
    const enqueue = vi.fn(async () => undefined);
    const sent: TeamChatSendRequest[] = [];
    const send = vi.fn(async (request: TeamChatSendRequest) => {
      sent.push(request);
      return { handle: `reply-${sent.length}` };
    });

    const conversation = {
      id: "conversation-1",
      provider: "slack",
      workspaceId: "T-1",
      externalKey: "channel:C-1:100.1",
      conversationId: "C-1",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "owner-1",
      displayName: "Leadership",
      participantNames: ["Ada", "Grace", "Arthur"],
      teamChatAmbientEnabled: null,
      teamChatRules: null,
      automatedSenderPolicies: {},
      thread: { id: "thread-1" },
    };

    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          id: "bot-1",
          spaceId: "space-1",
          userId: "owner-1",
          name: "Arthur",
          modelProvider: null,
          modelId: null,
          teamChatAmbientEnabled: false,
          teamChatRules: "",
        })),
      },
      externalConversation: { upsert: vi.fn(async () => conversation) },
      externalMessage: {
        upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
          const existing = records.find((r) => r.providerEventId === create.providerEventId);
          if (existing) return { ...existing, externalConversation: conversation };
          const record = {
            id: "external-1",
            status: create.status ?? "received",
            attempts: 0,
            runId: null,
            threadMessageId: null,
            replyThreadId: create.replyThreadId ?? null,
            kind: create.kind ?? "mention",
            senderId: create.senderId,
            senderName: create.senderName,
            senderIsBot: create.senderIsBot ?? false,
            content: create.content,
            providerEventId: create.providerEventId,
            batchContext: null,
            nextAttemptAt: null,
            createdAt: new Date(0),
            externalConversationId: conversation.id,
            externalConversation: conversation,
          };
          records.push(record);
          return record;
        }),
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (where.threadMessageId === null) {
            return records
              .filter((r) => r.threadMessageId === null)
              .map((r) => ({ ...r, externalConversation: conversation }));
          }
          if (where.status === "received") {
            return records
              .filter((r) => r.status === "received")
              .map((r) => ({ ...r, externalConversation: conversation }));
          }
          if (
            typeof where.status === "object" &&
            where.status &&
            "in" in (where.status as object)
          ) {
            const statuses = (where.status as { in: string[] }).in;
            return records
              .filter((r) => statuses.includes(String(r.status)))
              .map((r) => ({
                ...r,
                externalConversation: conversation,
                run: r.runId === "run-1" ? { id: "run-1", status: "completed", error: null } : null,
              }));
          }
          if (where.status === "observed") return [];
          return [];
        }),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const record = records.find((r) => r.id === where.id);
            Object.assign(record ?? {}, data);
            return record;
          },
        ),
        updateMany: vi.fn(
          async ({
            where,
            data,
          }: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
          }) => {
            let count = 0;
            for (const record of records) {
              if (where.id && record.id !== where.id) continue;
              if (where.status && record.status !== where.status) continue;
              if (
                "providerReplyHandle" in where &&
                where.providerReplyHandle === null &&
                record.providerReplyHandle
              ) {
                continue;
              }
              if (
                typeof where.providerReplyHandle === "object" &&
                where.providerReplyHandle &&
                "not" in (where.providerReplyHandle as object) &&
                !record.providerReplyHandle
              ) {
                continue;
              }
              Object.assign(record, data);
              count += 1;
            }
            return { count };
          },
        ),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          return records.find((record) => record.id === where.id) ?? null;
        }),
        findFirst: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
          if (!where) return null;
          return (
            records.find((record) => {
              if (where.id && record.id !== where.id) return false;
              if (where.status && record.status !== where.status) return false;
              if (
                typeof where.providerReplyHandle === "object" &&
                where.providerReplyHandle &&
                "not" in (where.providerReplyHandle as object)
              ) {
                return Boolean(record.providerReplyHandle);
              }
              return true;
            }) ?? null
          );
        }),
      },
      run: { findMany: vi.fn(async () => []) },
      message: {
        findFirst: vi.fn(async () => ({
          blocks: [{ kind: "text", text: "The launch plan is ready." }],
        })),
      },
    } as unknown as PrismaClient;

    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage },
      jobs: { enqueue },
      send,
      providerId: "slack",
      botId: "bot-1",
      reconcileIntervalMs: 60_000,
    });

    const inbound: TeamChatInboundMessage = {
      eventId: "Ev-1",
      workspaceId: "T-1",
      kind: "mention",
      conversationKey: "channel:C-1:100.1",
      conversationId: "C-1",
      replyThreadId: "100.1",
      senderId: "U-1",
      senderName: "Ada",
      conversationName: "Leadership",
      participantNames: ["Ada", "Grace", "Arthur"],
      content: "Review the launch plan",
    };

    await bridge.start();
    await expect(bridge.receive(inbound)).resolves.toEqual({
      spaceId: "space-1",
      userId: "owner-1",
      botId: "bot-1",
      threadId: "thread-1",
    });
    await bridge.receive(inbound);
    await bridge.stop();

    expect(prisma.externalConversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          botId: "bot-1",
          displayName: "Leadership",
          participantNames: ["Ada", "Grace", "Arthur"],
          thread: { create: { spaceId: "space-1", userId: "owner-1" } },
        }),
      }),
    );
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [{ kind: "text", text: "Review the launch plan" }],
        createRun: false,
        clientNonce: "teamchat-transcript:slack:Ev-1",
      }),
    );
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "owner-1",
        prompt: "Slack message from Ada:\n\nReview the launch plan",
        trigger: "messaging",
        clientNonce: "teamchat:slack:Ev-1",
      }),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([
      expect.objectContaining({
        conversationId: "C-1",
        replyThreadId: "100.1",
        content: "The launch plan is ready.",
      }),
    ]);
    expect(records[0]).toMatchObject({ status: "delivered" });
  });

  it("repairs previously observed messages that do not have transcript rows", async () => {
    const conversation = {
      id: "conversation-legacy",
      provider: "slack",
      workspaceId: "T-1",
      conversationId: "C-1",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "owner-1",
      thread: { id: "thread-legacy" },
    };
    const record = {
      id: "external-legacy",
      providerEventId: "Ev-legacy",
      senderName: "Pat",
      content: "This ordinary message was already observed.",
      threadMessageId: null as string | null,
      status: "ignored",
      externalConversation: conversation,
    };
    const sendUserMessage = vi.fn(async () => ({
      messageId: "message-visible",
      seq: 1,
      taskId: null,
      runId: null,
    }));
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          id: "bot-1",
          spaceId: "space-1",
          userId: "owner-1",
          name: "Arthur",
          modelProvider: null,
          modelId: null,
        })),
      },
      externalMessage: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (where.threadMessageId === null && record.threadMessageId === null) {
            return [{ ...record, externalConversation: conversation }];
          }
          return [];
        }),
        update: vi.fn(async ({ data }: { data: { threadMessageId?: string } }) => {
          if (data.threadMessageId) record.threadMessageId = data.threadMessageId;
          return record;
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      run: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;

    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
      reconcileIntervalMs: 60_000,
    });

    await bridge.start();
    await bridge.stop();

    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-legacy",
        blocks: [{ kind: "text", text: "This ordinary message was already observed." }],
        createRun: false,
      }),
    );
    expect(record.threadMessageId).toBe("message-visible");
  });
  it("does not reopen deliveries finalized as unconfirmed", async () => {
    const update = vi.fn();
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      externalMessage: {
        findUnique: vi.fn(async () => ({
          status: "delivered",
          providerReplyHandle: "unconfirmed",
        })),
        update,
        updateMany,
      },
    } as unknown as PrismaClient;

    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
      reconcileIntervalMs: 60_000,
    });

    await (
      bridge as unknown as {
        retry: (
          message: { id: string; status: string; attempts: number },
          error: unknown,
        ) => Promise<void>;
      }
    ).retry({ id: "message-1", status: "delivering", attempts: 0 }, new Error("send failed"));

    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("only retries rows that are still delivering without a provider handle", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      externalMessage: {
        findUnique: vi.fn(async () => ({
          status: "delivering",
          providerReplyHandle: null,
        })),
        update: vi.fn(),
        updateMany,
      },
    } as unknown as PrismaClient;

    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      send: vi.fn(),
      providerId: "slack",
      botId: "bot-1",
      reconcileIntervalMs: 60_000,
    });

    await (
      bridge as unknown as {
        retry: (
          message: { id: string; status: string; attempts: number },
          error: unknown,
        ) => Promise<void>;
      }
    ).retry({ id: "message-2", status: "running", attempts: 1 }, new Error("send failed"));

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "message-2",
          providerReplyHandle: null,
          status: "delivering",
        },
        data: expect.objectContaining({
          status: "delivering",
          attempts: 2,
          lastError: "send failed",
        }),
      }),
    );
  });
});
