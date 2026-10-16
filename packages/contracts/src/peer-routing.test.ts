import { describe, expect, it } from "vitest";
import { MessageBlock } from "./events.js";

describe("cross-Space peer receipt routing", () => {
  it("preserves the sent destination through validation", () => {
    const block = {
      kind: "bot_message_sent",
      toBotId: "bot-b",
      toBotName: "Scout",
      text: "Check",
      toSpaceId: "space-b",
      toSpaceName: "Research",
      toThreadId: "thread-b",
    };
    expect(MessageBlock.parse(block)).toEqual(block);
  });
  it("preserves the received return route through validation", () => {
    const block = {
      kind: "bot_message_received",
      fromBotId: "bot-a",
      fromBotName: "Chief",
      text: "Check",
      fromSpaceId: "space-a",
      fromSpaceName: "General",
      fromThreadId: "thread-a",
    };
    expect(MessageBlock.parse(block)).toEqual(block);
  });
});
