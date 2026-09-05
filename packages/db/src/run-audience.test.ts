import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { answerRunInput, claimSteering, finalizeRun, sendUserMessage } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";

const channelBlock: MessageBlock = {
  kind: "channel_message",
  provider: "fake",
  channelId: "group-1",
  fromAddress: "sender",
  fromLabel: "Sender",
  text: "Group request",
  hop: 0,
};
const scope = { spaceId: "space-1", threadId: "thread-1", botId: "bot-1", userId: "user-1" };
const fence = {
  ...scope,
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  leaseOwner: "worker",
  leaseFence: 1,
};

function fixture(audience: string | null = "channel:group-1") {
  const run = { id: "run-1", taskId: "task-1", status: "running", audience };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    thread: { update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 2 })) },
    message: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "message-1",
        seq: 1,
        ...data,
      })),
      update: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => ({
        id: "ask-1",
        blocks: [{ kind: "ask", text: "Details?", status: "pending" }],
      })),
    },
    run: {
      findFirst: vi.fn(async () => ({ ...run }) as typeof run | null),
      findUnique: vi.fn(async () => run),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "run-next",
        ...data,
      })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    task: {
      create: vi.fn(async () => ({ id: "task-next" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
    steeringMessage: {
      create: vi.fn(async () => ({})),
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      findMany: vi.fn(
        async () =>
          [] as Array<{
            id: string;
            messageId: string;
            userId: string;
            message: { id: string; seq: number; blocks: MessageBlock[]; audience: string | null };
          }>,
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    bot: { update: vi.fn(async () => ({})) },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "event-1",
        ...data,
      })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
  return { tx, prisma, run };
}

describe("run audiences", () => {
  it.each(["user", "follow_up", "messaging"] as const)(
    "keeps a private %s follow-up out of a group-origin run",
    async (trigger) => {
      const { prisma, tx } = fixture();
      const sent = await sendUserMessage(prisma, {
        ...scope,
        trigger,
        blocks: [{ kind: "text", text: "Private test detail" }],
        prompt: "Private test detail",
      });
      expect(sent.runId).toBeNull();
      expect(tx.steeringMessage.create).toHaveBeenCalledWith({
        data: {
          messageId: "message-1",
          botId: scope.botId,
          userId: scope.userId,
          runId: null,
        },
      });
      expect(tx.message.update).not.toHaveBeenCalled();
      expect(tx.run.create).not.toHaveBeenCalled();
      expect(tx.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ audience: trigger === "messaging" ? "dm" : null }),
      });
    },
  );

  it("accepts steering only from the same group", async () => {
    const { prisma, tx } = fixture();
    const input = {
      ...scope,
      trigger: "messaging" as const,
      blocks: [channelBlock],
      prompt: "Group request",
    };
    expect((await sendUserMessage(prisma, input)).runId).toBe("run-1");
    expect(tx.steeringMessage.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ runId: "run-1" }),
    });
    expect(
      (
        await sendUserMessage(prisma, {
          ...input,
          blocks: [{ ...channelBlock, channelId: "group-2" }],
        })
      ).runId,
    ).toBeNull();
  });

  it("does not inject group input into an active private run", async () => {
    const { prisma } = fixture("dm");
    expect(
      (
        await sendUserMessage(prisma, {
          ...scope,
          trigger: "messaging",
          blocks: [channelBlock],
          prompt: "Group request",
        })
      ).runId,
    ).toBeNull();
  });

  it("binds a newly created run to the trusted input audience", async () => {
    const { prisma, tx } = fixture();
    tx.run.findFirst.mockResolvedValue(null);
    await sendUserMessage(prisma, {
      ...scope,
      trigger: "messaging",
      blocks: [channelBlock],
      prompt: "Group request",
    });
    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ audience: "channel:group-1" }),
    });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ audience: "channel:group-1" }),
    });
  });

  it("claims only its audience, including when recovering unbound steering", async () => {
    const { prisma, tx } = fixture();
    await claimSteering(prisma, { ...fence, seenIds: [] });
    expect(tx.steeringMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          message: { threadId: "thread-1", audience: "channel:group-1" },
          OR: [{ runId: null }, { runId: "run-1" }],
        }),
      }),
    );
  });

  it.each([null, "dm", "channel:group-2"])(
    "continues pending audience %s without consuming other audiences",
    async (audience) => {
      const { prisma, tx } = fixture();
      tx.run.findFirst.mockResolvedValue(null);
      tx.steeringMessage.findFirst.mockResolvedValue({
        userId: scope.userId,
        message: { audience },
      });
      tx.steeringMessage.findFirstOrThrow.mockResolvedValue({ messageId: "last" });
      expect(await finalizeRun(prisma, { ...fence, outcome: "completed", blocks: [] })).toEqual({
        continuationRunId: "run-next",
      });
      expect(tx.run.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          audience,
          trigger: audience ? "messaging" : "follow_up",
          sourceMessageId: "last",
        }),
      });
      expect(tx.steeringMessage.updateMany).toHaveBeenLastCalledWith({
        where: { botId: scope.botId, runId: null, message: { threadId: scope.threadId, audience } },
        data: { runId: "run-next", claimedAt: null },
      });
      expect(tx.steeringMessage.findFirstOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            botId: scope.botId,
            runId: null,
            message: { threadId: scope.threadId, audience },
          },
          orderBy: [{ message: { seq: "desc" } }, { id: "desc" }],
        }),
      );
    },
  );

  it("makes a group run and its ask private before saving an in-app answer", async () => {
    const { prisma, tx, run } = fixture();
    expect(
      await answerRunInput(prisma, {
        ...scope,
        runId: run.id,
        messageId: "ask-1",
        answeredByUserId: scope.userId,
        answer: "Private test detail",
      }),
    ).toBe(true);
    expect(run.audience).toBeNull();
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "ask-1" },
      data: expect.objectContaining({ audience: null }),
    });
    // A later bot reply must inherit the new private audience, even if a caller
    // still holds the original group audience from before the answer.
    await createThreadMessageInTransaction(tx as never, {
      threadId: scope.threadId,
      runId: run.id,
      audience: "channel:group-1",
      role: "bot",
      blocks: [{ kind: "text", text: "Private reply" }],
    });
    expect(tx.message.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ audience: null }),
    });
  });
});
