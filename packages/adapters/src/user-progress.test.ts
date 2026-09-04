import type { MessageBlock } from "@rakazo/contracts";
import { isToolActivityBlock } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  clampUserProgressMessage,
  extractNarrationText,
  finalBlocksAfterMidTurnProgress,
  USER_PROGRESS_MESSAGE_MAX_LENGTH,
} from "./user-progress.js";

describe("clampUserProgressMessage", () => {
  it("trims and rejects empty text", () => {
    expect(clampUserProgressMessage("  hello  ")).toBe("hello");
    expect(clampUserProgressMessage("   ")).toBe("");
  });

  it("clamps long progress beats", () => {
    const clamped = clampUserProgressMessage("x".repeat(USER_PROGRESS_MESSAGE_MAX_LENGTH + 40));
    expect(clamped).toHaveLength(USER_PROGRESS_MESSAGE_MAX_LENGTH);
    expect(clamped.endsWith("…")).toBe(true);
  });
});

describe("extractNarrationText", () => {
  it("pulls text blocks and current text while keeping tool activity", () => {
    const { text, remaining } = extractNarrationText(
      [
        { kind: "text", text: "Checking calendars. " },
        { kind: "steps", steps: [{ label: "Web search", count: 1 }] },
        { kind: "text", text: "Found three options." },
      ],
      " Still looking.",
    );
    expect(text).toBe("Checking calendars. Found three options. Still looking.");
    expect(remaining).toEqual([{ kind: "steps", steps: [{ label: "Web search", count: 1 }] }]);
  });
});

describe("finalBlocksAfterMidTurnProgress", () => {
  it("drops a hollow final message that is only hidden tool activity", () => {
    const steps: MessageBlock = { kind: "steps", steps: [{ label: "Shell", count: 2 }] };
    expect(finalBlocksAfterMidTurnProgress([steps], true)).toEqual([]);
    expect(finalBlocksAfterMidTurnProgress([steps], false)).toEqual([steps]);
  });

  it("keeps a final answer alongside tool activity", () => {
    const blocks: MessageBlock[] = [
      { kind: "steps", steps: [{ label: "Web search", count: 1 }] },
      { kind: "text", text: "You are free Tuesday afternoon." },
    ];
    expect(finalBlocksAfterMidTurnProgress(blocks, true)).toEqual(blocks);
    expect(isToolActivityBlock(blocks[0]!)).toBe(true);
  });
});
