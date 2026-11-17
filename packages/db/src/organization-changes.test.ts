import { flush } from "@rakazo/core/test-async";
import { describe, expect, it, vi } from "vitest";
import { followOrganizationChanges, publishOrganizationChange } from "./organization-changes.js";

function fakeFanout() {
  const subscribers = new Map<string, Set<(payload: string) => void>>();
  const published: string[] = [];
  return {
    published,
    topics: () => [...subscribers.keys()],
    publish: async (topic: string, payload: string) => {
      published.push(topic);
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

function fakePrisma(memberIds: string[]) {
  const findMany = vi.fn(async (_args: unknown) => memberIds.map((userId) => ({ userId })));
  return { findMany, prisma: { member: { findMany } } as never };
}

describe("organization changes", () => {
  it("signals each member and anyone named, once each, and no one else", async () => {
    const fanout = fakeFanout();
    const { findMany, prisma } = fakePrisma(["owner", "alice"]);
    await publishOrganizationChange(prisma, fanout as never, "org-1", ["alice", "removed"]);
    await vi.waitFor(() => expect(fanout.published).toHaveLength(3));
    expect(fanout.published.sort()).toEqual([
      "organization-changes:alice",
      "organization-changes:owner",
      "organization-changes:removed",
    ]);
    // A guest is not shown the organization, so is not asked.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1", role: { not: "guest" } },
      }),
    );
  });

  it("signals on open, then on the user's own changes only", async () => {
    const fanout = fakeFanout();
    const controller = new AbortController();
    const iterator = followOrganizationChanges(fanout as never, "alice", controller.signal);
    expect(await iterator.next()).toEqual({ done: false, value: undefined });

    let signals = 0;
    const next = iterator.next().then((result) => {
      signals += 1;
      return result;
    });
    await fanout.publish("organization-changes:bob", "");
    await flush();
    expect(signals).toBe(0);

    await fanout.publish("organization-changes:alice", "");
    expect((await next).done).toBe(false);
    expect(signals).toBe(1);

    controller.abort();
    expect((await iterator.next()).done).toBe(true);
    expect(fanout.topics()).toEqual([]);
  });
});
