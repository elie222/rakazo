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
