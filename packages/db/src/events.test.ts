import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { finalizeComputerControlRelease, followThreadEvents } from "./events.js";

class TestFanout implements RealtimeFanout {
  subscriber: ((payload: string) => void) | undefined;
  unsubscribed = false;

  describe() {
    return {
      id: "test",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { distributed: false, push: true },
    };
  }

  async publish(_topic: string, payload: string) {
    this.subscriber?.(payload);
  }

  async subscribe(_topic: string, subscriber: (payload: string) => void) {
    this.subscriber = subscriber;
    return async () => {
      this.unsubscribed = true;
      this.subscriber = undefined;
    };
  }

  async close() {}
}

function event(seq: number) {
  return {
    id: `event-${seq}`,
    workspaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq,
    type: "run.started",
    payload: {},
    runId: null,
    createdAt: new Date("2026-08-15T12:00:00.000Z"),
  };
}

describe("followThreadEvents", () => {
  it("does not lose a notification that arrives while querying", async () => {
    const fanout = new TestFanout();
    const findMany = vi
      .fn()
      .mockImplementationOnce(async () => {
        await fanout.publish("thread:thread-1", "wake");
        return [];
      })
      .mockResolvedValueOnce([event(0)])
      .mockResolvedValue([]);
    const prisma = { event: { findMany } } as unknown as PrismaClient;
    const abort = new AbortController();
    const stream = followThreadEvents(prisma, "thread-1", -1, fanout, abort.signal, 10_000);

    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 0 }, done: false });
    expect(findMany).toHaveBeenCalledTimes(2);
    abort.abort();
    await stream.return(undefined);
    expect(fanout.unsubscribed).toBe(true);
  });

  it("periodically catches up when a signal is missed", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([event(0)]);
    const prisma = { event: { findMany } } as unknown as PrismaClient;
    const abort = new AbortController();
    const stream = followThreadEvents(prisma, "thread-1", -1, undefined, abort.signal, 1);

    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 0 }, done: false });
    abort.abort();
    await stream.return(undefined);
  });
});

describe("finalizeComputerControlRelease", () => {
  it("clears the matching lease and appends its release event in one transaction", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      bot: {
        findUnique: vi.fn().mockResolvedValue({ thread: { id: "thread-1" } }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      event: {
        create: vi.fn().mockResolvedValue({
          ...event(7),
          type: "computer.takeover.released",
          payload: { holder: "none", leaseId: "lease-1", reason: "expired" },
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      finalizeComputerControlRelease(
        prisma,
        {
          workspaceId: "workspace-1",
          botId: "bot-1",
          leaseId: "lease-1",
          holder: "none",
          reason: "expired",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: { botId: "bot-1", controlLeaseId: "lease-1" },
      data: {
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
      },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "computer.takeover.released",
          payload: { holder: "none", leaseId: "lease-1", reason: "expired" },
        }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 7 }));
  });
});
