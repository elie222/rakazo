import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { followThreadEvents } from "./events.js";

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
