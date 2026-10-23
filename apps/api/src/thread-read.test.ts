import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { ThreadTarget } from "./thread-target.js";
import { markThreadRead, markThreadUnreadFrom } from "./thread-target.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "fixture@example.test",
  isDeploymentOwner: false,
} satisfies Actor;
const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

type Row = { unread: boolean; lastReadSeq: number; nextMessageSeq: number };

/** A thread row that applies a conditional write only when the guard still matches. */
function threadStore(initial: Row, beforeWrite?: (row: Row) => void) {
  let row = { ...initial };
  const updateMany = vi.fn(async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
    beforeWrite?.(row);
    beforeWrite = undefined;
    const matches = Object.entries(where).every(
      ([key, value]) =>
        !(key in row) || (typeof value === "object" ? true : row[key as keyof Row] === value),
    );
    if (!matches) return { count: 0 };
    row = { ...row, ...data };
    return { count: 1 };
  });
  const findFirst = vi.fn(async ({ where }: { where: Record<string, string> }) =>
    where.userId === actor.userId && where.spaceId === actor.spaceId ? { ...row } : null,
  );
  // Message 4 of this thread; any other id or thread is unknown.
  const message = {
    findFirst: vi.fn(async ({ where }: { where: { id: string; threadId: string } }) =>
      where.id === "message-4" && where.threadId === "thread-1" ? { seq: 4 } : null,
    ),
  };
  const prisma = { thread: { findFirst, updateMany }, message } as unknown as PrismaClient;
  return { prisma, updateMany, row: () => row };
}

describe("markThreadRead", () => {
  it("returns where the user had read up to and moves the cursor to the latest message", async () => {
    const store = threadStore({ unread: true, lastReadSeq: 3, nextMessageSeq: 7 });
    await expect(markThreadRead(store.prisma, actor, target)).resolves.toBe(3);
    expect(store.row()).toEqual({ unread: false, lastReadSeq: 6, nextMessageSeq: 7 });
    expect(store.updateMany).toHaveBeenCalledWith({
      where: {
        id: "thread-1",
        spaceId: "space-1",
        userId: "user-1",
        lastReadSeq: 3,
        nextMessageSeq: 7,
      },
      data: { unread: false, lastReadSeq: 6 },
    });
    await expect(markThreadRead(store.prisma, actor, target)).resolves.toBeNull();
  });

  it("clears a chat marked unread by hand without inventing a divider", async () => {
    const store = threadStore({ unread: true, lastReadSeq: 6, nextMessageSeq: 7 });
    await expect(markThreadRead(store.prisma, actor, target)).resolves.toBeNull();
    expect(store.row().unread).toBe(false);
  });

  it("retries when a message lands between the read and the write", async () => {
    const store = threadStore({ unread: true, lastReadSeq: 3, nextMessageSeq: 7 }, (row) => {
      row.nextMessageSeq = 8;
    });
    await expect(markThreadRead(store.prisma, actor, target)).resolves.toBe(3);
    expect(store.row()).toEqual({ unread: false, lastReadSeq: 7, nextMessageSeq: 8 });
    expect(store.updateMany).toHaveBeenCalledTimes(2);
  });

  it("moves the cursor under the thread's row lock when replies keep landing mid-write", async () => {
    let row: Row = { unread: true, lastReadSeq: 3, nextMessageSeq: 7 };
    const findFirst = vi.fn(async () => ({ ...row }));
    // Every conditional write loses to a new reply.
    const updateMany = vi.fn(
      async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
        row = { ...row, nextMessageSeq: row.nextMessageSeq + 1 };
        if (where.nextMessageSeq !== undefined && where.nextMessageSeq !== row.nextMessageSeq) {
          return { count: 0 };
        }
        row = { ...row, ...data };
        return { count: 1 };
      },
    );
    const queryRaw = vi.fn(async () => [{ id: "thread-1" }]);
    const tx = {
      $queryRaw: queryRaw,
      thread: {
        findFirst,
        updateMany: vi.fn(async ({ data }: { data: Partial<Row> }) => {
          row = { ...row, ...data };
          return { count: 1 };
        }),
      },
    };
    const prisma = {
      thread: { findFirst, updateMany },
      $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
    } as unknown as PrismaClient;

    await expect(markThreadRead(prisma, actor, target)).resolves.toBe(3);
    expect(updateMany).toHaveBeenCalledTimes(3);
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(row).toEqual({ unread: false, lastReadSeq: 9, nextMessageSeq: 10 });
  });

  it("moves the cursor of a chat that wasn't unread without placing a divider", async () => {
    const store = threadStore({ unread: false, lastReadSeq: -1, nextMessageSeq: 1 });
    await expect(markThreadRead(store.prisma, actor, target)).resolves.toBeNull();
    expect(store.row()).toEqual({ unread: false, lastReadSeq: 0, nextMessageSeq: 1 });
  });

  it("does nothing for a thread outside the actor's space", async () => {
    const store = threadStore({ unread: true, lastReadSeq: 3, nextMessageSeq: 7 });
    await expect(
      markThreadRead(store.prisma, { ...actor, spaceId: "space-2" }, target),
    ).resolves.toBeNull();
    expect(store.updateMany).not.toHaveBeenCalled();
  });
});

describe("markThreadUnreadFrom", () => {
  it("moves the cursor to just before the message so the next open starts New there", async () => {
    const store = threadStore({ unread: false, lastReadSeq: 6, nextMessageSeq: 7 });
    await markThreadUnreadFrom(store.prisma, actor, target, "message-4");
    expect(store.row()).toEqual({ unread: true, lastReadSeq: 3, nextMessageSeq: 7 });
    await expect(markThreadRead(store.prisma, actor, target)).resolves.toBe(3);
  });

  it("refuses a message that isn't in the thread", async () => {
    const store = threadStore({ unread: false, lastReadSeq: 6, nextMessageSeq: 7 });
    await expect(
      markThreadUnreadFrom(store.prisma, actor, target, "message-elsewhere"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(store.row()).toEqual({ unread: false, lastReadSeq: 6, nextMessageSeq: 7 });
  });
});
