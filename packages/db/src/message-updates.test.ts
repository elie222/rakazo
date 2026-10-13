import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { updateThreadMessageWithEvent } from "./events.js";

function setup() {
  const order: string[] = [];
  const blocks: MessageBlock[] = [
    { kind: "voice_call", callId: "call-1", title: "Finished", farewell: "Goodbye" },
  ];
  const input = {
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    type: "thread.message.updated" as const,
    payload: { messageId: "message-1", role: "bot", blocks, callId: "call-1" },
  };
  const tx = {
    $queryRaw: vi.fn(async () => {
      order.push("lock");
      return [{ id: "thread-1" }];
    }),
    message: {
      updateMany: vi.fn(async () => {
        order.push("update");
        return { count: 1 };
      }),
      findFirstOrThrow: vi.fn(async () => ({ seq: 7 })),
    },
    thread: {
      update: vi.fn(async () => ({
        nextEventSeq: 23,
        lastReadSeq: 5,
        lastUnreadSeq: 7,
        unread: true,
      })),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        order.push("event");
        return { id: "event-1", createdAt: new Date("2026-10-01T00:00:00Z"), ...data };
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => {
      const result = await callback(tx);
      order.push("commit");
      return result;
    }),
  } as unknown as PrismaClient;
  return { prisma, tx, order, input };
}

describe("atomic message updates", () => {
  it("locks the scoped thread before editing and commits the normalized event together", async () => {
    const { prisma, tx, order, input } = setup();
    const event = await updateThreadMessageWithEvent(prisma, input);
    expect(order).toEqual(["lock", "update", "event", "commit"]);
    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: { id: "message-1", threadId: "thread-1" },
      data: { blocks: input.payload.blocks },
    });
    expect(event?.payload).toEqual({
      ...input.payload,
      messageSeq: 7,
      readState: { lastReadSeq: 5, lastUnreadSeq: 7, unread: true },
    });
  });

  it("waits for the clear lock and skips a message that clear removed", async () => {
    const { prisma, tx, order, input } = setup();
    let unlock!: (rows: Array<{ id: string }>) => void;
    const unlocked = new Promise<Array<{ id: string }>>((resolve) => {
      unlock = resolve;
    });
    tx.$queryRaw.mockImplementation(() => unlocked);
    tx.message.updateMany.mockResolvedValue({ count: 0 });
    const pending = updateThreadMessageWithEvent(prisma, input);
    expect(tx.message.updateMany).not.toHaveBeenCalled();
    unlock([{ id: "thread-1" }]);
    expect(await pending).toBeNull();
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(order).toEqual(["commit"]);
  });

  it("does not touch messages when the scoped thread no longer exists", async () => {
    const { prisma, tx, input } = setup();
    tx.$queryRaw.mockResolvedValue([]);
    expect(await updateThreadMessageWithEvent(prisma, input)).toBeNull();
    expect(tx.message.updateMany).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
  });
});
