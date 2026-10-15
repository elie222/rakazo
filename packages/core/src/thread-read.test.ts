import { describe, expect, it } from "vitest";
import {
  durableMessageSeq,
  latestDurableMessageSeq,
  threadReadAcknowledgement,
  threadReadStateFromPayload,
  unreadBoundary,
  unreadDividerMessageId,
} from "./thread-read.js";

describe("thread read positions", () => {
  it("never acknowledges live event positions or unpositioned messages", () => {
    const live = [
      { id: "progress:run-1", seq: 500 },
      { id: "subagent:agent-1", seq: 501 },
      { id: "pending-1" },
      { id: "legacy-event", seq: -1 },
      { id: "invalid", seq: Number.NaN },
    ];
    expect(live.map(durableMessageSeq)).toEqual(live.map(() => undefined));
    expect(latestDurableMessageSeq(live)).toBeUndefined();
    expect(latestDurableMessageSeq([...live, { id: "message-1", seq: 0 }])).toBe(0);
    expect(
      latestDurableMessageSeq([{ id: "message-2", seq: 2 }, ...live, { id: "message-1", seq: 1 }]),
    ).toBe(2);
  });

  it("distinguishes unseen messages from a manual unread reminder", () => {
    expect(unreadBoundary()).toBeNull();
    expect(unreadBoundary({ lastReadSeq: 4, lastUnreadSeq: 3, unread: true })).toBeNull();
    expect(unreadBoundary({ lastReadSeq: 4, lastUnreadSeq: 4, unread: true })).toBeNull();
    expect(unreadBoundary({ lastReadSeq: 4, lastUnreadSeq: 5, unread: false })).toBeNull();
    expect(unreadBoundary({ lastReadSeq: 4, lastUnreadSeq: 5, unread: true })).toBe(4);
    expect(unreadBoundary({ lastReadSeq: -1, lastUnreadSeq: 0, unread: true })).toBe(-1);
  });

  it("acknowledges visible history and clears reminders without consuming future arrivals", () => {
    const readState = { lastReadSeq: 8, lastUnreadSeq: 10, unread: true };
    expect(threadReadAcknowledgement(readState, undefined)).toBeUndefined();
    expect(threadReadAcknowledgement(readState, 7)).toBeUndefined();
    expect(threadReadAcknowledgement(readState, 8)).toBeUndefined();
    expect(threadReadAcknowledgement(readState, 9)).toBe(9);
    const reminder = { lastReadSeq: 8, lastUnreadSeq: 5, unread: true };
    expect(threadReadAcknowledgement(reminder, 5)).toBe(8);
    expect(threadReadAcknowledgement(reminder, undefined)).toBeUndefined();
    expect(
      threadReadAcknowledgement({ lastReadSeq: -1, lastUnreadSeq: -1, unread: true }, -1),
    ).toBe(-1);
    expect(threadReadAcknowledgement({ ...reminder, unread: false }, 5)).toBeUndefined();
  });

  it("places the divider only when the loaded page covers the boundary", () => {
    const messages = [
      { id: "progress:run-1", seq: 900 },
      { id: "message-8", seq: 8 },
      { id: "message-9", seq: 9 },
      { id: "message-10", seq: 10 },
    ];
    expect(unreadDividerMessageId(messages, 4, 8)).toBeNull();
    expect(unreadDividerMessageId(messages, 7, 8)).toBe("message-8");
    expect(unreadDividerMessageId(messages, 8, 8)).toBe("message-9");
    expect(unreadDividerMessageId(messages, 10, 8)).toBeNull();
    expect(unreadDividerMessageId(messages, null, null)).toBeNull();
    // The first visible message may follow hidden system/peer messages in a covered page.
    expect(unreadDividerMessageId(messages, 4, 3)).toBe("message-8");
    expect(unreadDividerMessageId(messages, -1, null)).toBe("message-8");
  });

  it("accepts only valid read state carried by events", () => {
    const readState = { lastReadSeq: 0, lastUnreadSeq: 3, unread: true };
    expect(threadReadStateFromPayload({ readState })).toEqual(readState);
    expect(threadReadStateFromPayload()).toBeUndefined();
    expect(
      threadReadStateFromPayload({ readState: { ...readState, lastReadSeq: -2 } }),
    ).toBeUndefined();
    expect(
      threadReadStateFromPayload({ readState: { ...readState, unread: "true" } }),
    ).toBeUndefined();
  });
});
