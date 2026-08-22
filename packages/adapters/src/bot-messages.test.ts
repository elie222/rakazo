import { describe, expect, it } from "vitest";
import { orderedBotPair, pingPongBlocked } from "./bot-messages.js";

describe("bot messaging", () => {
  it("orders a channel pair stably", () => {
    expect(orderedBotPair("b", "a")).toEqual(["a", "b"]);
    expect(orderedBotPair("a", "b")).toEqual(["a", "b"]);
  });

  it("blocks ping-pong after a burst of recent messages", () => {
    const now = Date.now();
    const recent = Array.from({ length: 8 }, (_, index) => new Date(now - index * 1000));
    expect(pingPongBlocked(recent, now)).toBe(true);
    expect(pingPongBlocked(recent.slice(0, 3), now)).toBe(false);
    expect(pingPongBlocked([new Date(now - 10 * 60 * 1000)], now)).toBe(false);
  });
});
