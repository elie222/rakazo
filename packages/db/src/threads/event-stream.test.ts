import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { notifyCommittedEvent, notifyRealtime, observeThreadChanges } from "./event-stream.js";

describe("notifyCommittedEvent", () => {
  it("resolves when the publish and the timing read both fail", async () => {
    const realtime = {
      publish: vi.fn().mockRejectedValue(new Error("fanout down")),
    } as unknown as RealtimeFanout;
    const prisma = {
      run: { findUnique: vi.fn().mockRejectedValue(new Error("database down")) },
    } as unknown as PrismaClient;
    await expect(
      notifyCommittedEvent(prisma, realtime, "thread-1", 3, "run-1"),
    ).resolves.toBeUndefined();
    expect(realtime.publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 3 }));
  });

  it("resolves when the publish throws before returning a promise", async () => {
    const realtime = {
      publish: vi.fn(() => {
        throw new Error("fanout closed");
      }),
    } as unknown as RealtimeFanout;
    const prisma = {} as PrismaClient;
    await expect(notifyCommittedEvent(prisma, realtime, "thread-1", 4)).resolves.toBeUndefined();
  });
});

describe("observeThreadChanges", () => {
  it("reports each published thread change after it reaches the fanout", async () => {
    const published: string[] = [];
    const realtime = {
      describe: vi.fn(),
      publish: vi.fn(async (topic: string) => {
        published.push(topic);
      }),
      subscribe: vi.fn(),
      close: vi.fn(),
    } as unknown as RealtimeFanout;
    const changed = vi.fn((threadId: string) => {
      expect(published).toContain(`thread:${threadId}`);
    });
    const observed = observeThreadChanges(realtime, changed);
    await notifyRealtime(observed, "thread-1", 4);
    await observed.publish("incoming-calls:user-1", "");
    expect(changed.mock.calls).toEqual([["thread-1"]]);
    expect(published).toEqual(["thread:thread-1", "incoming-calls:user-1"]);
  });

  it("still reports a committed change whose publish failed", async () => {
    const realtime = {
      publish: vi.fn().mockRejectedValue(new Error("fanout down")),
    } as unknown as RealtimeFanout;
    const changed = vi.fn();
    await notifyRealtime(observeThreadChanges(realtime, changed), "thread-1", 5);
    expect(changed).toHaveBeenCalledWith("thread-1");
  });
});
