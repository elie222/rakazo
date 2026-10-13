import { describe, expect, it } from "vitest";
import type { MobileSnapshot } from "./api";
import { mobileVisibleReadSeq, pinnedVisibleMessageIds } from "./thread-read";

const snapshot: MobileSnapshot = {
  threadId: "thread-1",
  cursor: 100,
  olderCursor: null,
  run: null,
  readState: { lastReadSeq: 2, lastUnreadSeq: 5, unread: true },
  messages: [2, 3, 4, 5].map((seq) => ({
    id: `message-${seq}`,
    seq,
    role: "bot",
    blocks: [{ kind: "text", text: `Reply ${seq}` }],
  })),
};
const reading = {
  snapshot,
  visibleIds: new Set(["message-3"]),
  active: true,
  focused: true,
  ready: true,
  readOnly: false,
};

describe("mobile visible message acknowledgements", () => {
  it("acknowledges the displayed message without consuming newer offscreen replies", () => {
    expect(mobileVisibleReadSeq(reading)).toBe(3);
    expect(
      mobileVisibleReadSeq({ ...reading, visibleIds: new Set(["message-2"]) }),
    ).toBeUndefined();
    expect(
      mobileVisibleReadSeq({ ...reading, visibleIds: new Set(["message-3", "message-4"]) }),
    ).toBe(4);
  });

  it.each([
    { active: false },
    { focused: false },
    { ready: false },
    { readOnly: true },
    { visibleIds: new Set<string>() },
    { snapshot: null },
    { snapshot: { ...snapshot, readState: undefined } },
  ])("does not acknowledge a hidden, stale, unpositioned or read-only screen: %j", (state) => {
    expect(mobileVisibleReadSeq({ ...reading, ...state })).toBeUndefined();
  });

  it("never uses stream event positions or viewability left over after clearing", () => {
    expect(
      mobileVisibleReadSeq({
        ...reading,
        snapshot: {
          ...snapshot,
          messages: [{ id: "progress:run", seq: 100, role: "bot", blocks: [] }],
        },
        visibleIds: new Set(["progress:run"]),
      }),
    ).toBeUndefined();
    expect(
      mobileVisibleReadSeq({ ...reading, snapshot: { ...snapshot, messages: [] } }),
    ).toBeUndefined();
  });

  it("clears a manual reminder once a durable message is visible", () => {
    const reminder = { ...snapshot, readState: { lastReadSeq: 5, lastUnreadSeq: 5, unread: true } };
    expect(mobileVisibleReadSeq({ ...reading, snapshot: reminder })).toBe(5);
    expect(
      mobileVisibleReadSeq({ ...reading, snapshot: reminder, visibleIds: new Set(["message-5"]) }),
    ).toBe(5);
    expect(
      mobileVisibleReadSeq({
        ...reading,
        snapshot: { ...snapshot, readState: { lastReadSeq: 20, lastUnreadSeq: 4, unread: true } },
      }),
    ).toBe(20);
    expect(
      mobileVisibleReadSeq({ ...reading, snapshot: reminder, visibleIds: new Set() }),
    ).toBeUndefined();
  });

  it("does not advance from an old search result past the saved cursor", () => {
    expect(
      mobileVisibleReadSeq({
        ...reading,
        snapshot: { ...snapshot, readState: { lastReadSeq: 4, lastUnreadSeq: 5, unread: true } },
      }),
    ).toBeUndefined();
  });

  it("clears an empty-chat reminder only after its empty list is laid out", () => {
    const empty = {
      ...snapshot,
      messages: [],
      readState: { lastReadSeq: -1, lastUnreadSeq: -1, unread: true },
    };
    expect(mobileVisibleReadSeq({ ...reading, snapshot: empty })).toBeUndefined();
    expect(mobileVisibleReadSeq({ ...reading, snapshot: empty, emptyVisible: true })).toBe(-1);
    expect(
      mobileVisibleReadSeq({ ...reading, snapshot: empty, emptyVisible: true, focused: false }),
    ).toBeUndefined();
  });
});

describe("mobile pinned history visibility", () => {
  const layouts = new Map([
    ["above", { y: 0, height: 80 }],
    ["under-header", { y: 100, height: 40 }],
    ["visible", { y: 200, height: 100 }],
    ["below", { y: 600, height: 100 }],
  ]);

  it("uses the viewport instead of treating all mounted history as read", () => {
    expect([...pinnedVisibleMessageIds(layouts, { offset: 100, viewport: 400 }, 60)]).toEqual([
      "visible",
    ]);
    expect([...pinnedVisibleMessageIds(layouts, { offset: 400, viewport: 400 }, 60)]).toEqual([
      "below",
    ]);
    expect([...pinnedVisibleMessageIds(layouts, { offset: 100, viewport: 0 }, 60)]).toEqual([]);
  });

  it("recognizes a tall reply once it occupies half the usable viewport", () => {
    const tall = new Map([["long", { y: 400, height: 2000 }]]);
    expect([...pinnedVisibleMessageIds(tall, { offset: 100, viewport: 400 }, 0)]).toEqual([]);
    expect([...pinnedVisibleMessageIds(tall, { offset: 300, viewport: 400 }, 0)]).toEqual(["long"]);
  });
});
