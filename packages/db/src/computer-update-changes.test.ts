import { describe, expect, it } from "vitest";
import {
  followComputerUpdateChanges,
  publishComputerUpdateChange,
} from "./computer-update-changes.js";

function fakeFanout() {
  const subscribers = new Map<string, Set<(payload: string) => void>>();
  return {
    topics: () => [...subscribers.keys()],
    publish: async (topic: string, payload: string) => {
      for (const subscriber of subscribers.get(topic) ?? []) subscriber(payload);
    },
    subscribe: async (topic: string, callback: (payload: string) => void) => {
      const set = subscribers.get(topic) ?? new Set();
      set.add(callback);
      subscribers.set(topic, set);
      return async () => {
        set.delete(callback);
        if (set.size === 0) subscribers.delete(topic);
      };
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("followComputerUpdateChanges", () => {
  it("signals on open, then on changes in its own Space only", async () => {
    const fanout = fakeFanout();
    const iterator = followComputerUpdateChanges(fanout as never, "space-1");
    expect((await iterator.next()).done).toBe(false);

    const next = iterator.next();
    let signalled = false;
    void next.then(() => {
      signalled = true;
    });
    await publishComputerUpdateChange(fanout as never, "space-2");
    await tick();
    expect(signalled).toBe(false);

    await publishComputerUpdateChange(fanout as never, "space-1");
    expect((await next).done).toBe(false);

    await iterator.return(undefined);
    expect(fanout.topics()).toEqual([]);
  });

  it("publishes nothing without a fanout and never throws for a failed publish", async () => {
    await expect(publishComputerUpdateChange(undefined, "space-1")).resolves.toBeUndefined();
    const failing = {
      publish: async () => {
        throw new Error("offline");
      },
    };
    await expect(publishComputerUpdateChange(failing as never, "space-1")).resolves.toBeUndefined();
  });
});

describe("publishComputerUpdateChange", () => {
  it("retries through a short database outage", async () => {
    let calls = 0;
    const fanout = {
      publish: async () => {
        calls += 1;
        if (calls === 1)
          throw Object.assign(new Error("terminating connection"), { code: "57P01" });
      },
    };
    await publishComputerUpdateChange(fanout as never, "space-1", { sleep: async () => {} });
    expect(calls).toBe(1);
    await tick();
    expect(calls).toBe(2);
  });

  it("returns at once and gives up quietly on other failures", async () => {
    let calls = 0;
    const fanout = {
      publish: async () => {
        calls += 1;
        throw new Error("bad payload");
      },
    };
    await expect(
      publishComputerUpdateChange(fanout as never, "space-1", { sleep: async () => {} }),
    ).resolves.toBeUndefined();
    await tick();
    expect(calls).toBe(1);
  });
});
