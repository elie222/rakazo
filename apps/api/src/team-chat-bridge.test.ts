import type {
  TeamChatInboundMessage,
  TeamChatProvider,
  TeamChatSendRequest,
} from "@rakazo/adapter-kit";
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
      messages: [
        {
          senderName: "Pat",
          senderId: "U123",
          content: "Launch moved to Friday.",
        },
      ],
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
        : {
            messageId: "message-prompt",
            seq: 2,
            taskId: "task-1",
            runId: "run-1",
          },
    );
    const enqueue = vi.fn(async () => undefined);
    const provider = new FakeTeamChatProvider();
    const conversation = {
      id: "conversation-1",
      provider: "slack",
      workspaceId: "T-1",
      externalKey: "channel:C-1:100.1",
      conversationId: "C-1",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "owner-1",
      thread: { id: "thread-1" },
    };
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          id: "bot-1",
          spaceId: "space-1",
          userId: "owner-1",
          name: "Arthur",
        })),
      },
      externalConversation: { upsert: vi.fn(async () => conversation) },
      externalMessage: {
        upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
          const existing = records.find(
            (record) => record.providerEventId === create.providerEventId,
          );
          if (existing) return existing;
          const record = {
            id: "external-1",
            status: "received",
            attempts: 0,
            runId: null,
            ...create,
            externalConversation: conversation,
          };
          records.push(record);
          return record;
        }),
        findMany: vi.fn(async ({ where }: { where: { status: string | { in: string[] } } }) =>
          records
            .filter((record) => matchesStatus(record.status, where.status))
            .map((record) => ({
              ...record,
              externalConversation: conversation,
              run:
                record.runId === "run-1" ? { id: "run-1", status: "completed", error: null } : null,
            })),
        ),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const record = records.find((candidate) => candidate.id === where.id);
            Object.assign(record ?? {}, data);
            return record;
          },
        ),
        updateMany: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { id?: string | { in?: string[] }; status?: string | { in: string[] } };
            data: Record<string, unknown>;
          }) => {
            const ids =
              typeof where.id === "string" ? [where.id] : (where.id as { in?: string[] })?.in;
            let count = 0;
            for (const record of records) {
              if (
                (!ids || ids.includes(String(record.id))) &&
                matchesStatus(record.status, where.status)
              ) {
                Object.assign(record, data);
                count += 1;
              }
            }
            return { count };
          },
        ),
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
      provider,
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
    await provider.emit(inbound);
    await provider.emit(inbound);
    await bridge.stop();

    expect(prisma.externalConversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          botId: "bot-1",
          displayName: "Leadership",
          participantNames: ["Ada", "Grace", "Arthur"],
          thread: {
            create: {
              spaceId: "space-1",
              userId: "owner-1",
            },
          },
        }),
      }),
    );
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [{ kind: "text", text: "Review the launch plan" }],
        speakerName: "Ada",
        createRun: false,
        clientNonce: "external-transcript:slack:Ev-1",
      }),
    );
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "owner-1",
        prompt: "Slack message from Ada:\n\nReview the launch plan",
        trigger: "external_message",
        clientNonce: "external:slack:Ev-1",
        hiddenInTranscript: true,
      }),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(provider.sent).toEqual([
      {
        conversationId: "C-1",
        replyThreadId: "100.1",
        content: "The launch plan is ready.",
        idempotencyKey: "external-message:external-1",
      },
    ]);
    expect(records[0]).toMatchObject({
      status: "delivered",
      providerReplyHandle: "reply-1",
    });
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
        })),
      },
      externalMessage: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          where.threadMessageId === null && record.threadMessageId === null ? [record] : [],
        ),
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
      provider: new FakeTeamChatProvider(),
      botId: "bot-1",
      reconcileIntervalMs: 60_000,
    });

    await bridge.start();
    await bridge.stop();

    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-legacy",
        blocks: [{ kind: "text", text: "This ordinary message was already observed." }],
        speakerName: "Pat",
        createRun: false,
      }),
    );
    expect(record.threadMessageId).toBe("message-visible");
  });

  it("delivers a multi-agent result through Arthur to the originating Slack thread", async () => {
    const provider = new FakeTeamChatProvider();
    let mirrored = false;
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          id: "bot-arthur",
          spaceId: "space-1",
          userId: "owner-1",
          name: "Arthur",
        })),
      },
      externalMessage: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async ({ where }: { where: { runId?: string } }) =>
          where.runId === "run-external"
            ? {
                id: "external-1",
                replyThreadId: "100.1",
                externalConversation: { conversationId: "C-1" },
              }
            : null,
        ),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      run: {
        findMany: vi.fn(async () =>
          mirrored
            ? []
            : [
                {
                  id: "run-arthur-result",
                  status: "completed",
                  sourceMessageId: "message-from-specialist",
                },
              ],
        ),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === "run-arthur-delegates-again"
            ? { sourceMessageId: "message-parent-source" }
            : null,
        ),
        updateMany: vi.fn(async () => {
          mirrored = true;
          return { count: 1 };
        }),
      },
      message: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          if (where.id === "message-from-specialist") {
            return { replyTo: { runId: "run-arthur-delegates-again" } };
          }
          if (where.id === "message-parent-source") {
            return { replyTo: { runId: "run-external" } };
          }
          return null;
        }),
        findFirst: vi.fn(async () => ({
          blocks: [{ kind: "text", text: "Research found that the launch should move." }],
        })),
      },
    } as unknown as PrismaClient;
    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn() },
      provider,
      botId: "bot-arthur",
      reconcileIntervalMs: 60_000,
    });

    await bridge.start();
    await bridge.stop();

    expect(provider.sent).toEqual([
      {
        conversationId: "C-1",
        replyThreadId: "100.1",
        content: "Research found that the launch should move.",
        idempotencyKey: "team-chat-run:run-arthur-result",
      },
    ]);
    expect(prisma.run.updateMany).toHaveBeenCalledWith({
      where: { id: "run-arthur-result", teamChatMirroredAt: null },
      data: { teamChatMirroredAt: expect.any(Date) },
    });
  });

  it("keeps ambient channel traffic silent when channel listening is disabled", async () => {
    const records: Array<Record<string, unknown>> = [];
    const sendUserMessage = vi.fn(async () => ({
      messageId: "message-visible",
      seq: 1,
      taskId: null,
      runId: null,
    }));
    const judge = { decide: vi.fn() };
    const provider = new FakeTeamChatProvider();
    const conversation = {
      id: "conversation-ambient",
      provider: "slack",
      workspaceId: "T-1",
      externalKey: "channel:C-1",
      conversationId: "C-1",
      displayName: "launch",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "owner-1",
      thread: { id: "thread-ambient" },
    };
    const prisma = ambientPrisma(records, conversation, false) as unknown as PrismaClient;
    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage },
      jobs: { enqueue: vi.fn() },
      provider,
      judge,
      botId: "bot-1",
      ambientDebounceMs: 0,
      reconcileIntervalMs: 60_000,
    });

    await bridge.start();
    await provider.emit(ambientMessage());
    await bridge.stop();

    expect(judge.decide).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [{ kind: "text", text: "The committed launch date moved to Friday." }],
        speakerName: "Ada",
        createRun: false,
      }),
    );
    expect(records[0]).toMatchObject({ status: "ignored" });
  });

  it("batches ambient traffic and starts one run only when the judge elects to act", async () => {
    const records: Array<Record<string, unknown>> = [];
    const sendUserMessage = vi.fn(async (input: { createRun?: boolean }) =>
      input.createRun === false
        ? { messageId: "message-visible", taskId: null, runId: null }
        : {
            messageId: "message-prompt",
            taskId: "task-ambient",
            runId: "run-ambient",
          },
    );
    const enqueue = vi.fn(async () => undefined);
    const judge = {
      decide: vi.fn(async () => ({
        act: true,
        reason: "A committed launch date changed.",
        askedByEventId: "Ev-ambient",
      })),
    };
    const provider = new FakeTeamChatProvider();
    const conversation = {
      id: "conversation-ambient",
      provider: "slack",
      workspaceId: "T-1",
      externalKey: "channel:C-1",
      conversationId: "C-1",
      displayName: "launch",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "owner-1",
      thread: { id: "thread-ambient" },
    };
    const prisma = ambientPrisma(records, conversation, true) as unknown as PrismaClient;
    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage },
      jobs: { enqueue },
      provider,
      judge,
      botId: "bot-1",
      ambientDebounceMs: 0,
      reconcileIntervalMs: 60_000,
    });

    await bridge.start();
    await provider.emit(ambientMessage());
    await bridge.stop();

    expect(judge.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C-1",
        channelName: "launch",
        rules: "Engage when a committed date changes.",
      }),
    );
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("A committed launch date changed."),
        hiddenInTranscript: true,
      }),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not discard an elected ambient trigger before promoting it", async () => {
    const records: Array<Record<string, unknown>> = [];
    const sendUserMessage = vi.fn(async (input: { createRun?: boolean }) =>
      input.createRun === false
        ? { messageId: "message-visible", taskId: null, runId: null }
        : { messageId: "message-prompt", taskId: "task-ambient", runId: "run-ambient" },
    );
    const judge = {
      decide: vi.fn(async () => ({
        act: true,
        reason: "A committed launch date changed.",
        askedByEventId: "Ev-ambient",
      })),
    };
    const conversation = {
      id: "conversation-ambient",
      provider: "slack",
      workspaceId: "T-1",
      externalKey: "channel:C-1",
      conversationId: "C-1",
      displayName: "launch",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "owner-1",
      thread: { id: "thread-ambient" },
    };
    const prisma = ambientPrisma(records, conversation, true) as unknown as PrismaClient;
    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage },
      jobs: { enqueue: vi.fn(async () => undefined) },
      provider: new FakeTeamChatProvider(),
      judge,
      botId: "bot-1",
      ambientDebounceMs: 0,
      reconcileIntervalMs: 60_000,
    });

    await bridge.start();
    await bridge.receive(ambientMessage());
    await bridge.stop();

    expect(prisma.externalMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "external-1", status: "observed" },
        data: expect.objectContaining({ status: "received" }),
      }),
    );
    expect(prisma.externalMessage.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["external-1"] }, status: "observed" },
        data: expect.objectContaining({ status: "ignored" }),
      }),
    );
  });

  it("does not resend when delivery is already reserved with a future lease", async () => {
    const provider = new FakeTeamChatProvider();
    const futureLease = new Date(Date.now() + 60_000);
    const record = {
      id: "external-1",
      status: "delivering",
      attempts: 0,
      kind: "mention",
      runId: "run-1",
      replyThreadId: "100.1",
      nextAttemptAt: futureLease,
      run: { id: "run-1", status: "completed" },
      externalConversation: {
        provider: "slack",
        botId: "bot-1",
        conversationId: "C-1",
      },
    };
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          id: "bot-1",
          spaceId: "space-1",
          userId: "owner-1",
          name: "Arthur",
        })),
      },
      externalMessage: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          matchesDeliveryCandidate(record, where) ? [record] : [],
        ),
        updateMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => ({
          count: matchesReserveWhere(record, where) ? 1 : 0,
        })),
      },
      run: { findMany: vi.fn(async () => []) },
      message: {
        findFirst: vi.fn(async () => ({
          blocks: [{ kind: "text", text: "Already being sent." }],
        })),
      },
    } as unknown as PrismaClient;
    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage: vi.fn() },
      jobs: { enqueue: vi.fn(async () => undefined) },
      provider,
      botId: "bot-1",
      reconcileIntervalMs: 60_000,
    });

    await bridge.start();
    await bridge.stop();

    expect(provider.sent).toEqual([]);
    expect(prisma.externalMessage.updateMany).not.toHaveBeenCalled();
  });

  it("reclaims abandoned delivering messages with a past or null lease once", async () => {
    const provider = new FakeTeamChatProvider();
    for (const nextAttemptAt of [new Date(Date.now() - 60_000), null] as const) {
      provider.sent.length = 0;
      const record = {
        id: "external-1",
        status: "delivering",
        attempts: 0,
        kind: "mention",
        runId: "run-1",
        replyThreadId: "100.1",
        nextAttemptAt: nextAttemptAt as Date | null,
        run: { id: "run-1", status: "completed" },
        externalConversation: {
          provider: "slack",
          botId: "bot-1",
          conversationId: "C-1",
        },
      };
      const prisma = {
        bot: {
          findFirst: vi.fn(async () => ({
            id: "bot-1",
            spaceId: "space-1",
            userId: "owner-1",
            name: "Arthur",
          })),
        },
        externalMessage: {
          findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
            matchesDeliveryCandidate(record, where) ? [record] : [],
          ),
          updateMany: vi.fn(
            async ({
              where,
              data,
            }: {
              where: Record<string, unknown>;
              data: Record<string, unknown>;
            }) => {
              if (!matchesReserveWhere(record, where)) return { count: 0 };
              Object.assign(record, data);
              return { count: 1 };
            },
          ),
          update: vi.fn(
            async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
              if (where.id === record.id) Object.assign(record, data);
              return record;
            },
          ),
        },
        run: { findMany: vi.fn(async () => []) },
        message: {
          findFirst: vi.fn(async () => ({
            blocks: [{ kind: "text", text: "Recovered send." }],
          })),
        },
      } as unknown as PrismaClient;
      const bridge = new TeamChatBridge({
        prisma,
        events: { sendUserMessage: vi.fn() },
        jobs: { enqueue: vi.fn(async () => undefined) },
        provider,
        botId: "bot-1",
        reconcileIntervalMs: 60_000,
      });

      await bridge.start();
      await bridge.stop();

      expect(provider.sent).toEqual([
        {
          conversationId: "C-1",
          replyThreadId: "100.1",
          content: "Recovered send.",
          idempotencyKey: "external-message:external-1",
        },
      ]);
      expect(prisma.externalMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "external-1",
            status: "delivering",
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: expect.any(Date) } }],
          }),
          data: expect.objectContaining({
            status: "delivering",
            nextAttemptAt: expect.any(Date),
          }),
        }),
      );

      // Simulate a second instance that already observed the row before the lease refresh:
      // reclaim must fail while the fresh lease is held.
      record.status = "delivering";
      record.nextAttemptAt = new Date(Date.now() + 120_000);
      (prisma.externalMessage.findMany as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) =>
          where.status &&
          matchesStatus(record.status, where.status as string | { in: string[] } | undefined)
            ? [record]
            : [],
      );
      provider.sent.length = 0;
      await bridge.start();
      await bridge.stop();
      expect(provider.sent).toEqual([]);
    }
  });

  it("uses room listening and guidance instead of Arthur's defaults", async () => {
    const records: Array<Record<string, unknown>> = [];
    const sendUserMessage = vi.fn(async (input: { createRun?: boolean }) =>
      input.createRun === false
        ? { messageId: "message-visible", taskId: null, runId: null }
        : { messageId: "message-prompt", taskId: "task-room", runId: "run-room" },
    );
    const judge = {
      decide: vi.fn(async () => ({ act: false, reason: "No action needed." })),
    };
    const conversation = {
      id: "conversation-ambient",
      provider: "slack",
      workspaceId: "T-1",
      externalKey: "channel:C-1",
      conversationId: "C-1",
      displayName: "launch",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "owner-1",
      teamChatAmbientEnabled: true,
      teamChatRules: "Only engage when the launch owner changes.",
      automatedSenderPolicies: {},
      thread: { id: "thread-ambient" },
    };
    const prisma = ambientPrisma(records, conversation, false) as unknown as PrismaClient;
    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage },
      jobs: { enqueue: vi.fn(async () => undefined) },
      provider: new FakeTeamChatProvider(),
      judge,
      botId: "bot-1",
      ambientDebounceMs: 0,
      reconcileIntervalMs: 60_000,
    });

    await bridge.start();
    await bridge.receive(ambientMessage());
    await bridge.stop();

    expect(judge.decide).toHaveBeenCalledWith(
      expect.objectContaining({ rules: "Only engage when the launch owner changes." }),
    );
  });

  it("mirrors ignored automated posts without invoking the judge", async () => {
    const records: Array<Record<string, unknown>> = [];
    const sendUserMessage = vi.fn(async () => ({
      messageId: "message-visible",
      taskId: null,
      runId: null,
    }));
    const judge = {
      decide: vi.fn(async () => ({ act: true, reason: "Should not run." })),
    };
    const conversation = {
      id: "conversation-ambient",
      provider: "slack",
      workspaceId: "T-1",
      externalKey: "channel:C-1",
      conversationId: "C-1",
      displayName: "launch",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "owner-1",
      teamChatAmbientEnabled: true,
      teamChatRules: null,
      automatedSenderPolicies: {
        "B-GITHUB": { name: "GitHub", mode: "ignore" },
      },
      thread: { id: "thread-ambient" },
    };
    const prisma = ambientPrisma(records, conversation, true) as unknown as PrismaClient;
    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage },
      jobs: { enqueue: vi.fn(async () => undefined) },
      provider: new FakeTeamChatProvider(),
      judge,
      botId: "bot-1",
      ambientDebounceMs: 0,
      reconcileIntervalMs: 60_000,
    });

    await bridge.start();
    await bridge.receive({
      ...ambientMessage(),
      eventId: "Ev-github",
      senderId: "B-GITHUB",
      senderName: "GitHub",
      senderIsBot: true,
      content: "Pull request #42 is ready for review.",
    });
    await bridge.stop();

    expect(sendUserMessage).toHaveBeenCalledOnce();
    expect(judge.decide).not.toHaveBeenCalled();
    expect(records[0]?.status).toBe("ignored");
  });

  it("runs actionable automated posts without spending a judge call", async () => {
    const records: Array<Record<string, unknown>> = [];
    const sendUserMessage = vi.fn(async (input: { createRun?: boolean }) =>
      input.createRun === false
        ? { messageId: "message-visible", taskId: null, runId: null }
        : { messageId: "message-prompt", taskId: "task-action", runId: "run-action" },
    );
    const enqueue = vi.fn(async () => undefined);
    const judge = {
      decide: vi.fn(async () => ({ act: false, reason: "Should not be consulted." })),
    };
    const conversation = {
      id: "conversation-ambient",
      provider: "slack",
      workspaceId: "T-1",
      externalKey: "channel:C-1",
      conversationId: "C-1",
      displayName: "launch",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "owner-1",
      teamChatAmbientEnabled: true,
      teamChatRules: null,
      automatedSenderPolicies: {
        "B-GITHUB": { name: "GitHub", mode: "action" },
      },
      thread: { id: "thread-ambient" },
    };
    const prisma = ambientPrisma(records, conversation, true) as unknown as PrismaClient;
    const bridge = new TeamChatBridge({
      prisma,
      events: { sendUserMessage },
      jobs: { enqueue },
      provider: new FakeTeamChatProvider(),
      judge,
      botId: "bot-1",
      ambientDebounceMs: 0,
      reconcileIntervalMs: 60_000,
    });

    await bridge.start();
    await bridge.receive({
      ...ambientMessage(),
      eventId: "Ev-github",
      senderId: "B-GITHUB",
      senderName: "GitHub",
      senderIsBot: true,
      content: "Production deployment failed.",
    });
    await bridge.stop();

    expect(judge.decide).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
    expect(sendUserMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("configured as actionable"),
        hiddenInTranscript: true,
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("holds rollup posts until their configured interval elapses", async () => {
    const records: Array<Record<string, unknown>> = [];
    const sendUserMessage = vi.fn(async () => ({
      messageId: "message-visible",
      taskId: null,
      runId: null,
    }));
    const judge = {
      decide: vi.fn(async () => ({ act: true, reason: "Should remain grouped." })),
    };
    const conversation = {
      id: "conversation-ambient",
      provider: "slack",
      workspaceId: "T-1",
      externalKey: "channel:C-1",
      conversationId: "C-1",
      displayName: "launch",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "owner-1",
      teamChatAmbientEnabled: true,
      teamChatRules: null,
      automatedSenderPolicies: {
        "B-LINEAR": { name: "Linear", mode: "rollup", rollupHours: 6 },
      },
      thread: { id: "thread-ambient" },
    };
    const prisma = ambientPrisma(records, conversation, true);
    prisma.externalMessage.findFirst.mockResolvedValue({ judgedAt: new Date() });
    const bridge = new TeamChatBridge({
      prisma: prisma as unknown as PrismaClient,
      events: { sendUserMessage },
      jobs: { enqueue: vi.fn(async () => undefined) },
      provider: new FakeTeamChatProvider(),
      judge,
      botId: "bot-1",
      ambientDebounceMs: 0,
      reconcileIntervalMs: 60_000,
    });

    await bridge.start();
    await bridge.receive({
      ...ambientMessage(),
      eventId: "Ev-linear",
      senderId: "B-LINEAR",
      senderName: "Linear",
      senderIsBot: true,
      content: "Issue ENG-42 changed status.",
    });
    await bridge.stop();

    expect(sendUserMessage).toHaveBeenCalledOnce();
    expect(judge.decide).not.toHaveBeenCalled();
    expect(records[0]?.status).toBe("observed");
  });
});

function ambientMessage(): TeamChatInboundMessage {
  return {
    eventId: "Ev-ambient",
    workspaceId: "T-1",
    kind: "ambient",
    conversationKey: "channel:C-1",
    conversationId: "C-1",
    conversationName: "launch",
    replyThreadId: "105.001",
    senderId: "U-1",
    senderName: "Ada",
    content: "The committed launch date moved to Friday.",
  };
}

function ambientPrisma(
  records: Array<Record<string, unknown>>,
  conversation: Record<string, unknown>,
  ambientEnabled: boolean,
) {
  const bot = {
    id: "bot-1",
    spaceId: "space-1",
    userId: "owner-1",
    name: "Arthur",
    modelProvider: null,
    modelId: null,
    teamChatAmbientEnabled: ambientEnabled,
    teamChatRules: "Engage when a committed date changes.",
  };
  return {
    bot: { findFirst: vi.fn(async () => bot) },
    externalConversation: { upsert: vi.fn(async () => conversation) },
    externalMessage: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        const record = {
          id: `external-${records.length + 1}`,
          attempts: 0,
          runId: null,
          batchContext: null,
          engagementReason: null,
          createdAt: new Date(0),
          ...create,
          externalConversation: conversation,
        };
        records.push(record);
        return record;
      }),
      findMany: vi.fn(async ({ where }: { where: { status: string | { in: string[] } } }) =>
        records
          .filter((record) => matchesStatus(record.status, where.status))
          .map((record) => ({
            ...record,
            externalConversation: conversation,
            run: null,
          })),
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const ids = (where.id as { in?: string[] } | undefined)?.in;
          let count = 0;
          for (const record of records) {
            if (
              (!ids || ids.includes(String(record.id))) &&
              matchesStatus(record.status, where.status ?? String(record.status))
            ) {
              Object.assign(record, data);
              count += 1;
            }
          }
          return { count };
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const record = records.find((candidate) => candidate.id === where.id);
          Object.assign(record ?? {}, data);
          return record;
        },
      ),
      findFirst: vi.fn(async () => null as { judgedAt: Date } | null),
    },
    run: { findMany: vi.fn(async () => []) },
    message: { findFirst: vi.fn(async () => null) },
  };
}

function matchesStatus(value: unknown, status: string | { in: string[] } | undefined): boolean {
  if (!status) return true;
  const current = String(value);
  return typeof status === "string" ? current === status : status.in.includes(current);
}

function matchesNextAttemptAt(
  value: Date | null | undefined,
  where: Record<string, unknown>,
): boolean {
  const clause = where.OR as Array<Record<string, unknown>> | undefined;
  if (!clause) return true;
  const now = Date.now();
  return clause.some((entry) => {
    if ("nextAttemptAt" in entry && entry.nextAttemptAt === null) return value == null;
    const lte = (entry.nextAttemptAt as { lte?: Date } | undefined)?.lte;
    if (lte) return value != null && value.getTime() <= lte.getTime();
    if (value == null) return true;
    return value.getTime() <= now;
  });
}

function matchesDeliveryCandidate(
  record: { status: string; nextAttemptAt?: Date | null },
  where: Record<string, unknown>,
): boolean {
  if (!where.status) return false;
  return (
    matchesStatus(record.status, where.status as string | { in: string[] } | undefined) &&
    matchesNextAttemptAt(record.nextAttemptAt, where)
  );
}

function matchesReserveWhere(
  record: { id: string; status: string; nextAttemptAt?: Date | null },
  where: Record<string, unknown>,
): boolean {
  if (where.id !== record.id) return false;
  if (!matchesStatus(record.status, where.status as string | { in: string[] } | undefined))
    return false;
  return matchesNextAttemptAt(record.nextAttemptAt, where);
}

class FakeTeamChatProvider implements TeamChatProvider {
  readonly id = "slack";
  readonly sent: TeamChatSendRequest[] = [];
  private handle: ((message: TeamChatInboundMessage) => Promise<void>) | undefined;

  async start(handle: (message: TeamChatInboundMessage) => Promise<void>): Promise<void> {
    this.handle = handle;
  }

  async stop(): Promise<void> {}

  async send(request: TeamChatSendRequest): Promise<{ handle: string }> {
    this.sent.push(request);
    return { handle: `reply-${this.sent.length}` };
  }

  async emit(message: TeamChatInboundMessage): Promise<void> {
    if (!this.handle) throw new Error("provider not started");
    await this.handle(message);
  }
}
