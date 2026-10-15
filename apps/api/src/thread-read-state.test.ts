import type { Actor, ThreadReadState } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { ThreadTarget } from "./thread-target.js";
import { setThreadUnreadState } from "./thread-target.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "reader@example.test",
  isDeploymentOwner: false,
};
const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

function fixture(initial: ThreadReadState & { nextMessageSeq: number }) {
  const row = { ...initial, nextEventSeq: 0 };
  const tx = {
    $queryRaw: vi.fn(async () => [{ ...row }]),
    thread: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (typeof data.lastReadSeq === "number") row.lastReadSeq = data.lastReadSeq;
        if (typeof data.unread === "boolean") row.unread = data.unread;
        if (data.nextEventSeq) row.nextEventSeq++;
        return { ...row };
      }),
    },
    event: { create: vi.fn(async ({ data }: { data: { seq: number } }) => data) },
  };
  const deps = {
    prisma: {
      $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    } as unknown as PrismaClient,
    events: { notify: vi.fn(async () => undefined) },
  };
  return { deps, tx, row };
}

describe("thread read acknowledgements", () => {
  it("keeps newer arrivals unread, synchronizes progress and ignores a stale device", async () => {
    const { deps, tx } = fixture({
      lastReadSeq: 2,
      lastUnreadSeq: 7,
      unread: true,
      nextMessageSeq: 9,
    });
    await expect(setThreadUnreadState(deps, actor, target, false, 5)).resolves.toEqual({
      lastReadSeq: 5,
      lastUnreadSeq: 7,
      unread: true,
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.read.updated",
        payload: { readState: { lastReadSeq: 5, lastUnreadSeq: 7, unread: true } },
      }),
    });
    expect(deps.events.notify).toHaveBeenCalledWith("thread-1", 0);
    await expect(setThreadUnreadState(deps, actor, target, false, 3)).resolves.toEqual({
      lastReadSeq: 5,
      lastUnreadSeq: 7,
      unread: true,
    });
    expect(tx.event.create).toHaveBeenCalledTimes(1);
    await expect(setThreadUnreadState(deps, actor, target, false, 7)).resolves.toEqual({
      lastReadSeq: 7,
      lastUnreadSeq: 7,
      unread: false,
    });
  });

  it("caps acknowledgements at committed history so future arrivals stay unread", async () => {
    const { deps } = fixture({
      lastReadSeq: -1,
      lastUnreadSeq: 3,
      unread: true,
      nextMessageSeq: 4,
    });
    await expect(setThreadUnreadState(deps, actor, target, false, 500)).resolves.toEqual({
      lastReadSeq: 3,
      lastUnreadSeq: 3,
      unread: false,
    });
  });

  it("preserves a manual reminder on stale reads and clears it when reopened", async () => {
    const { deps } = fixture({
      lastReadSeq: 4,
      lastUnreadSeq: 4,
      unread: false,
      nextMessageSeq: 5,
    });
    await expect(setThreadUnreadState(deps, actor, target, true)).resolves.toEqual({
      lastReadSeq: 4,
      lastUnreadSeq: 4,
      unread: true,
    });
    expect((await setThreadUnreadState(deps, actor, target, false, 3)).unread).toBe(true);
    expect((await setThreadUnreadState(deps, actor, target, false, 4)).unread).toBe(false);
    await setThreadUnreadState(deps, actor, target, true);
    expect((await setThreadUnreadState(deps, actor, target, false)).unread).toBe(false);
  });

  it("requires an owned thread under the scoped write lock", async () => {
    const { deps, tx } = fixture({
      lastReadSeq: -1,
      lastUnreadSeq: -1,
      unread: false,
      nextMessageSeq: 0,
    });
    tx.$queryRaw.mockResolvedValueOnce([]);
    await expect(setThreadUnreadState(deps, actor, target, false, 0)).rejects.toThrow();
    const [query, ...parameters] = tx.$queryRaw.mock.calls[0]! as unknown as [
      TemplateStringsArray,
      ...string[],
    ];
    expect(query.join("?")).toContain('"userId" = ? FOR UPDATE');
    expect(parameters).toEqual([target.threadId, actor.spaceId, actor.userId]);
    expect(tx.thread.update).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
  });
});
