import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { isPendingSendMessage, withPendingSend } from "./pending-send";

const stored = (seq: number, text: string): ThreadMessage => ({
  id: `m${seq}`,
  threadId: "t1",
  seq,
  role: "user",
  blocks: [{ kind: "text", text }],
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("withPendingSend", () => {
  const messages = [stored(1, "hi"), stored(2, "hello")];
  const pending = { threadKey: "bot1", clientNonce: "n1", text: "new words", afterSeq: 2 };

  it("shows an unconfirmed send last, after the chat's messages", () => {
    const shown = withPendingSend(messages, pending, "bot1", "t1");
    expect(shown).toHaveLength(3);
    const last = shown[2]!;
    expect(isPendingSendMessage(last)).toBe(true);
    expect(last).toMatchObject({ role: "user", seq: 3, threadId: "t1" });
    expect(last.blocks).toEqual([{ kind: "text", text: "new words" }]);
  });

  it("keeps showing a confirmed send until its stored message arrives", () => {
    const confirmed = { ...pending, acceptedSeq: 3 };
    expect(withPendingSend(messages, confirmed, "bot1", "t1")).toHaveLength(3);
    const arrived = [...messages, stored(3, "new words")];
    expect(withPendingSend(arrived, confirmed, "bot1", "t1")).toBe(arrived);
  });

  it("hides the send once a live update delivers it before the server answers", () => {
    const arrived = [...messages, stored(3, "new words")];
    expect(withPendingSend(arrived, pending, "bot1", "t1")).toBe(arrived);
    // The same words sent earlier are not this send.
    const earlier = [stored(1, "new words"), stored(2, "hello")];
    expect(withPendingSend(earlier, pending, "bot1", "t1")).toHaveLength(3);
  });

  it("shows nothing in another chat", () => {
    expect(withPendingSend(messages, pending, "bot2", "t2")).toBe(messages);
    expect(withPendingSend(messages, null, "bot1", "t1")).toBe(messages);
  });
});
