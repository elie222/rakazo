import type { ChatAlert } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { createChatAlerts } from "./chat-alerts.js";

function fakeFanout() {
  const subscribers = new Map<string, Set<(payload: string) => void>>();
  return {
    publish: async (topic: string, payload: string) => {
      for (const subscriber of subscribers.get(topic) ?? []) subscriber(payload);
    },
    subscribe: (topic: string, callback: (payload: string) => void) => {
      const set = subscribers.get(topic) ?? new Set();
      set.add(callback);
      subscribers.set(topic, set);
      return Promise.resolve(async () => {
        set.delete(callback);
      });
    },
  };
}

const alert: ChatAlert = {
  kind: "help",
  title: "Scout needs an answer",
  body: "Which repo?",
  spaceId: "space-1",
  botId: "bot-1",
  threadId: "thread-1",
};

describe("createChatAlerts", () => {
  it("delivers only the followed user's alerts, skipping malformed ones", async () => {
    const fanout = fakeFanout();
    const alerts = createChatAlerts(fanout as never);
    const iterator = alerts.follow("user-1");
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await alerts.publish("user-2", { ...alert, body: "Not yours" });
    await fanout.publish("chat-alerts:user-1", "{");
    await fanout.publish("chat-alerts:user-1", JSON.stringify({ kind: "help" }));
    await alerts.publish("user-1", alert);
    expect((await pending).value).toEqual(alert);
    await iterator.return(undefined);
  });

  it("ends the stream on abort", async () => {
    const controller = new AbortController();
    const iterator = createChatAlerts(fakeFanout() as never).follow("user-1", controller.signal);
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect((await pending).done).toBe(true);
  });

  it("does not throw without a realtime fanout", async () => {
    await expect(createChatAlerts().publish("user-1", alert)).resolves.toBeUndefined();
  });
});
