import { describe, expect, it } from "vitest";
import { SENT_ENTRANCE_WINDOW_MS, sentMessageEntrances } from "./sent-message-entrance.js";

const mine = (id: string) => ({ id, role: "user", author: { id: "me" } });
const bot = (id: string) => ({ id, role: "bot" });

describe("sentMessageEntrances", () => {
  it("animates your message the first time it appears after a send in this tab", () => {
    const result = sentMessageEntrances({
      messages: [mine("a"), bot("b"), mine("c")],
      seenIds: new Set(["a", "b"]),
      pendingSends: [1_000],
      meId: "me",
      now: 1_500,
    });
    expect(result).toEqual({ entering: ["c"], pendingSends: [] });
  });

  it("animates nothing without a send from this tab", () => {
    const result = sentMessageEntrances({
      messages: [mine("a"), mine("c")],
      seenIds: new Set(["a"]),
      pendingSends: [],
      meId: "me",
      now: 1_500,
    });
    expect(result.entering).toEqual([]);
  });

  it("keeps the send pending while only bots and other people write", () => {
    const result = sentMessageEntrances({
      messages: [mine("a"), bot("b"), { id: "c", role: "user", author: { id: "someone" } }],
      seenIds: new Set(["a"]),
      pendingSends: [1_000],
      meId: "me",
      now: 1_500,
    });
    expect(result).toEqual({ entering: [], pendingSends: [1_000] });
  });

  it("never animates an older page loaded above the shown messages", () => {
    const result = sentMessageEntrances({
      messages: [mine("old"), mine("a")],
      seenIds: new Set(["a"]),
      pendingSends: [1_000],
      meId: "me",
      now: 1_500,
    });
    expect(result).toEqual({ entering: [], pendingSends: [1_000] });
  });

  it("drops a send whose message never came within the window", () => {
    const result = sentMessageEntrances({
      messages: [mine("a"), mine("c")],
      seenIds: new Set(["a"]),
      pendingSends: [0],
      meId: "me",
      now: SENT_ENTRANCE_WINDOW_MS + 1,
    });
    expect(result).toEqual({ entering: [], pendingSends: [] });
  });

  it("gives each send at most one message", () => {
    const result = sentMessageEntrances({
      messages: [mine("a"), mine("b"), mine("c")],
      seenIds: new Set(["a"]),
      pendingSends: [1_000],
      meId: "me",
      now: 1_500,
    });
    expect(result).toEqual({ entering: ["b"], pendingSends: [] });
  });
});
