import { describe, expect, it } from "vitest";
import { peerChipPress } from "./peer-chip";

describe("peer chip press", () => {
  it("opens the exchange from a bot chat's Messaged chip", () => {
    expect(peerChipPress({ sent: true, threadBotId: "chief", peerBotId: "researcher" })).toBe(
      "open",
    );
  });

  it("toggles a received chip's folded replies before anything else", () => {
    expect(
      peerChipPress({
        sent: false,
        replies: "collapsed",
        threadBotId: "chief",
        peerBotId: "researcher",
      }),
    ).toBe("toggle");
    expect(peerChipPress({ sent: false, threadBotId: "chief", peerBotId: "researcher" })).toBe(
      "open",
    );
  });

  it("stays still when the exchange cannot be opened", () => {
    // Group chats and chips without a peer have no single bot-to-bot exchange to show.
    expect(peerChipPress({ sent: true, peerBotId: "researcher" })).toBeUndefined();
    expect(peerChipPress({ sent: true, threadBotId: "chief", peerBotId: "" })).toBeUndefined();
    expect(peerChipPress({ sent: true, threadBotId: "chief", peerBotId: "chief" })).toBeUndefined();
  });
});
