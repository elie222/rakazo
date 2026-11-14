import { describe, expect, it } from "vitest";
import { followSpaceChanges, publishSpaceChange } from "./space-changes.js";

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

async function opened(iterator: AsyncGenerator<string>) {
  const kinds = [];
  for (let i = 0; i < 3; i += 1) kinds.push((await iterator.next()).value);
  return kinds;
}

describe("followSpaceChanges", () => {
  it("signals every kind on open, then each change in its own Space only", async () => {
    const fanout = fakeFanout();
    const iterator = followSpaceChanges(fanout as never, "space-1");
    expect(await opened(iterator)).toEqual(["computerUpdates", "runs", "routines"]);

    const next = iterator.next();
    let signalled = false;
    void next.then(() => {
      signalled = true;
    });
    await publishSpaceChange(fanout as never, "space-2", "runs");
    await tick();
    expect(signalled).toBe(false);

    await publishSpaceChange(fanout as never, "space-1", "routines");
    expect((await next).value).toBe("routines");

    await iterator.return(undefined);
    expect(fanout.topics()).toEqual([]);
  });

  it("coalesces a burst of one kind and keeps kinds apart", async () => {
    const fanout = fakeFanout();
    const controller = new AbortController();
    const iterator = followSpaceChanges(fanout as never, "space-1", controller.signal);
    await opened(iterator);
    await publishSpaceChange(fanout as never, "space-1", "runs");
    await publishSpaceChange(fanout as never, "space-1", "runs");
    await publishSpaceChange(fanout as never, "space-1", "computerUpdates");
    await publishSpaceChange(fanout as never, "space-1", "runs");
    expect((await iterator.next()).value).toBe("runs");
    expect((await iterator.next()).value).toBe("computerUpdates");

    const next = iterator.next();
    let signalled = false;
    void next.then(() => {
      signalled = true;
    });
    await tick();
    expect(signalled).toBe(false);
    controller.abort();
    await next;
    expect(fanout.topics()).toEqual([]);
  });

  it("ignores unknown payloads and hears the previous release's computer update topic", async () => {
    const fanout = fakeFanout();
    const iterator = followSpaceChanges(fanout as never, "space-1");
    await opened(iterator);
    await fanout.publish("space-changes:space-1", "billing");
    await fanout.publish("computer-updates:space-1", "");
    expect((await iterator.next()).value).toBe("computerUpdates");
    await iterator.return(undefined);
  });

  it("signals every kind when the fanout asks subscribers to catch up", async () => {
    const fanout = fakeFanout();
    const iterator = followSpaceChanges(fanout as never, "space-1");
    await opened(iterator);
    await fanout.publish("space-changes:space-1", "");
    expect(await opened(iterator)).toEqual(["computerUpdates", "runs", "routines"]);
    await iterator.return(undefined);
  });
});

describe("publishSpaceChange", () => {
  it("publishes nothing without a fanout and never throws for a failed publish", async () => {
    await expect(publishSpaceChange(undefined, "space-1", "runs")).resolves.toBeUndefined();
    const failing = {
      publish: async () => {
        throw new Error("offline");
      },
    };
    await expect(publishSpaceChange(failing as never, "space-1", "runs")).resolves.toBeUndefined();
  });

  it("retries through a short database outage", async () => {
    let calls = 0;
    const fanout = {
      publish: async () => {
        calls += 1;
        if (calls === 1)
          throw Object.assign(new Error("terminating connection"), { code: "57P01" });
      },
    };
    await publishSpaceChange(fanout as never, "space-1", "runs", { sleep: async () => {} });
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
      publishSpaceChange(fanout as never, "space-1", "routines", { sleep: async () => {} }),
    ).resolves.toBeUndefined();
    await tick();
    expect(calls).toBe(1);
  });
});
