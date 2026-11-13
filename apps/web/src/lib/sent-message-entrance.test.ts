import { describe, expect, it } from "vitest";
import {
  SENT_ENTRANCE_WINDOW_MS,
  sentMessageEntrances,
  withNewSends,
  withoutUnsent,
} from "./sent-message-entrance.js";

const mine = (id: string) => ({ id, role: "user", author: { id: "me" } });
const bot = (id: string) => ({ id, role: "bot" });

describe("sentMessageEntrances", () => {
  it("animates your message the first time it appears after a send in this tab", () => {
    const result = sentMessageEntrances({
      messages: [mine("a"), bot("b"), mine("c")],
      seenIds: new Set(["a", "b"]),
      pendingSends: [{ sentAt: 1_000 }],
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
      pendingSends: [{ sentAt: 1_000 }],
      meId: "me",
      now: 1_500,
    });
    expect(result).toEqual({ entering: [], pendingSends: [{ sentAt: 1_000 }] });
  });

  it("never animates an older page loaded above the shown messages", () => {
    const result = sentMessageEntrances({
      messages: [mine("old"), mine("a")],
      seenIds: new Set(["a"]),
      pendingSends: [{ sentAt: 1_000 }],
      meId: "me",
      now: 1_500,
    });
    expect(result).toEqual({ entering: [], pendingSends: [{ sentAt: 1_000 }] });
  });

  it("drops a send whose message never came within the window", () => {
    const result = sentMessageEntrances({
      messages: [mine("a"), mine("c")],
      seenIds: new Set(["a"]),
      pendingSends: [{ sentAt: 0 }],
      meId: "me",
      now: SENT_ENTRANCE_WINDOW_MS + 1,
    });
    expect(result).toEqual({ entering: [], pendingSends: [] });
  });

  it("gives each send at most one message, the newest", () => {
    const result = sentMessageEntrances({
      messages: [mine("a"), mine("b"), mine("c")],
      seenIds: new Set(["a"]),
      pendingSends: [{ sentAt: 1_000 }],
      meId: "me",
      now: 1_500,
    });
    expect(result).toEqual({ entering: ["c"], pendingSends: [] });
  });

  it("leaves the send to its own text when the same person writes from another tab", () => {
    const result = sentMessageEntrances({
      messages: [
        mine("a"),
        { id: "b", role: "user", author: { id: "me" }, text: "From the other tab" },
        { id: "c", role: "user", author: { id: "me" }, text: "Hello" },
      ],
      seenIds: new Set(["a"]),
      pendingSends: [{ sentAt: 1_000, text: "Hello" }],
      meId: "me",
      now: 1_500,
    });
    expect(result).toEqual({ entering: ["c"], pendingSends: [] });
  });

  it("animates the new message, not an older one with the same text in a late snapshot", () => {
    const result = sentMessageEntrances({
      messages: [
        { id: "old", role: "user", author: { id: "me" }, text: "Thanks" },
        { id: "b", role: "bot" },
        { id: "new", role: "user", author: { id: "me" }, text: "Thanks" },
      ],
      seenIds: new Set(),
      pendingSends: [{ sentAt: 1_000, text: "Thanks" }],
      meId: "me",
      now: 1_500,
    });
    expect(result).toEqual({ entering: ["new"], pendingSends: [] });
  });
});

describe("pending sends", () => {
  it("gives each send that landed in one render its own entrance and text", () => {
    expect(withNewSends([], ["First", "Second"], 2, 1_000)).toEqual([
      { sentAt: 1_000, text: "First" },
      { sentAt: 1_000, text: "Second" },
    ]);
  });

  it("drops only the send that produced no message", () => {
    const pending = [
      { sentAt: 1_000, text: "First" },
      { sentAt: 1_000, text: "Second" },
    ];
    expect(withoutUnsent(pending, ["First"])).toEqual([{ sentAt: 1_000, text: "Second" }]);
  });
});
