import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { PendingSend } from "./pending-send";
import {
  isPendingSendMessage,
  newestMessageSeq,
  withoutDeliveredSends,
  withPendingSends,
} from "./pending-send";

const stored = (seq: number, text: string, authorId?: string): ThreadMessage => ({
  id: `m${seq}`,
  threadId: "t1",
  seq,
  role: "user",
  blocks: [{ kind: "text", text }],
  ...(authorId ? { author: { id: authorId, name: authorId } } : {}),
  createdAt: "2026-01-01T00:00:00.000Z",
});

const shownTexts = (messages: ThreadMessage[]) =>
  messages
    .filter(isPendingSendMessage)
    .map((message) => (message.blocks[0]?.kind === "text" ? message.blocks[0].text : ""));

describe("withPendingSends", () => {
  const messages = [stored(1, "hi"), stored(2, "hello")];
  const pending: PendingSend = {
    threadKey: "bot1",
    clientNonce: "n1",
    text: "new words",
    afterSeq: 2,
  };

  it("shows an unconfirmed send last, after the chat's messages", () => {
    const shown = withPendingSends(messages, [pending], "bot1", "t1", "me");
    expect(shown).toHaveLength(3);
    const last = shown[2]!;
    expect(isPendingSendMessage(last)).toBe(true);
    expect(last).toMatchObject({ role: "user", seq: 3, threadId: "t1" });
    expect(last.blocks).toEqual([{ kind: "text", text: "new words" }]);
  });

  it("shows the reply a send carries", () => {
    const reply = { ...pending, replyToMessageId: "m1", replyQuote: "hi" };
    expect(withPendingSends(messages, [reply], "bot1", "t1", "me")[2]).toMatchObject({
      replyToMessageId: "m1",
      replyQuote: "hi",
    });
  });

  it("keeps a confirmed send until its stored message arrives", () => {
    const confirmed = { ...pending, acceptedSeq: 3 };
    expect(withPendingSends(messages, [confirmed], "bot1", "t1", "me")).toHaveLength(3);
    const arrived = [...messages, stored(3, "new words")];
    expect(withPendingSends(arrived, [confirmed], "bot1", "t1", "me")).toBe(arrived);
  });

  it("hides a send once a live update delivers it before the server answers", () => {
    const arrived = [...messages, stored(3, "new words")];
    expect(withPendingSends(arrived, [pending], "bot1", "t1", "me")).toBe(arrived);
    // The same words sent earlier are not this send.
    const earlier = [stored(1, "new words"), stored(2, "hello")];
    expect(withPendingSends(earlier, [pending], "bot1", "t1", "me")).toHaveLength(3);
  });

  it("shows every send of a quick run, each until its own stored message", () => {
    const second = { ...pending, clientNonce: "n2", text: "more words" };
    expect(shownTexts(withPendingSends(messages, [pending, second], "bot1", "t1", "me"))).toEqual([
      "new words",
      "more words",
    ]);
    const firstArrived = [...messages, stored(3, "new words")];
    expect(
      shownTexts(withPendingSends(firstArrived, [pending, second], "bot1", "t1", "me")),
    ).toEqual(["more words"]);
  });

  it("matches one stored message to one of two sends with the same words", () => {
    const again = { ...pending, clientNonce: "n2" };
    const oneArrived = [...messages, stored(3, "new words")];
    expect(shownTexts(withPendingSends(oneArrived, [pending, again], "bot1", "t1", "me"))).toEqual([
      "new words",
    ]);
  });

  it("is not hidden by another group member's message with the same words", () => {
    const group = { ...pending, threadKey: "group1" };
    const fromOther = [...messages, stored(3, "new words", "someone-else")];
    expect(withPendingSends(fromOther, [group], "group1", "t1", "me")).toHaveLength(4);
    const fromMe = [...messages, stored(3, "new words", "me")];
    expect(withPendingSends(fromMe, [group], "group1", "t1", "me")).toBe(fromMe);
  });

  it("shows nothing in another chat", () => {
    expect(withPendingSends(messages, [pending], "bot2", "t2", "me")).toBe(messages);
    expect(withPendingSends(messages, [], "bot1", "t1", "me")).toBe(messages);
  });
});

describe("withoutDeliveredSends", () => {
  const accepted: PendingSend = {
    threadKey: "bot1",
    clientNonce: "n1",
    text: "new words",
    afterSeq: 2,
    acceptedSeq: 3,
  };

  it("drops a send once the chat holds its stored message, and only then", () => {
    const waiting = [accepted, { ...accepted, clientNonce: "n2", acceptedSeq: undefined }];
    expect(withoutDeliveredSends(waiting, [stored(2, "hello")], "bot1")).toBe(waiting);
    expect(withoutDeliveredSends(waiting, [stored(3, "new words")], "bot1")).toEqual([waiting[1]]);
    // Newer messages mean the stored one is in older history the chat has not loaded.
    expect(withoutDeliveredSends(waiting, [stored(9, "later")], "bot1")).toEqual([waiting[1]]);
    // Another chat's seq numbers say nothing about this send.
    expect(withoutDeliveredSends(waiting, [stored(3, "new words")], "bot2")).toBe(waiting);
  });
});

describe("newestMessageSeq", () => {
  it("ignores live rows that carry no seq", () => {
    const live = {
      ...stored(0, "typing"),
      id: "progress:run-1",
      seq: undefined,
    } as unknown as ThreadMessage;
    expect(newestMessageSeq([stored(4, "hi"), live])).toBe(4);
    const streaming = { ...stored(40, "working"), id: "progress:run-2" };
    expect(newestMessageSeq([stored(4, "hi"), streaming])).toBe(4);
  });
});
