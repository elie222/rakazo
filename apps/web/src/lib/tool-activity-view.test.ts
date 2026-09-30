import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  formatToolActivityDuration,
  isToolOnlyNarration,
  messageHasVisibleBlocks,
  renderableMessageBlocks,
  shouldRenderToolCard,
  toolStepCount,
} from "./tool-activity-view";

const stepsBlock: MessageBlock = { kind: "steps", steps: [{ label: "Shell", count: 2 }] };
const stepsNoDuration: MessageBlock = { kind: "steps", steps: [{ label: "Shell", count: 2 }] };
const textBlock: MessageBlock = { kind: "text", text: "Here you go." };
const liveActivity: MessageBlock = { kind: "progress", text: "Using shell", activity: true };
const narration: MessageBlock = { kind: "progress", text: "Let me check that." };

describe("formatToolActivityDuration", () => {
  it.each([
    [0, "0ms"],
    [850, "850ms"],
    [999, "999ms"],
    [1000, "1s"],
    [4200, "4.2s"],
    [12000, "12s"],
    [19179, "19s"],
    [60000, "1m 00s"],
    [65000, "1m 05s"],
    [103000, "1m 43s"],
  ])("formats %ims as %s", (ms, expected) => {
    expect(formatToolActivityDuration(ms)).toBe(expected);
  });

  it("omits unusable durations", () => {
    expect(formatToolActivityDuration(undefined)).toBeNull();
    expect(formatToolActivityDuration(null)).toBeNull();
    expect(formatToolActivityDuration(Number.NaN)).toBeNull();
    expect(formatToolActivityDuration(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatToolActivityDuration(-1)).toBeNull();
  });
});

describe("tool step count", () => {
  it("sums each row's count", () => {
    expect(toolStepCount([{ count: 1 }, { count: 3 }])).toBe(4);
    expect(toolStepCount([])).toBe(0);
  });
});

describe("tool card render decisions", () => {
  it("renders only steps blocks, and only when the preference is on", () => {
    expect(shouldRenderToolCard(stepsBlock, true)).toBe(true);
    expect(shouldRenderToolCard(stepsBlock, false)).toBe(false);
    expect(shouldRenderToolCard(textBlock, true)).toBe(false);
    expect(shouldRenderToolCard(liveActivity, true)).toBe(false);
  });

  it("keeps text order and drops hidden activity per preference", () => {
    const blocks = [textBlock, stepsBlock, liveActivity, narration];
    expect(renderableMessageBlocks(blocks, true)).toEqual([textBlock, stepsBlock, narration]);
    expect(renderableMessageBlocks(blocks, false)).toEqual([textBlock, narration]);
  });

  it("never surfaces a progress block marked as activity", () => {
    expect(messageHasVisibleBlocks([liveActivity], true)).toBe(false);
    expect(messageHasVisibleBlocks([liveActivity], false)).toBe(false);
  });

  it("keeps a steps-only message visible only when the preference is on", () => {
    expect(messageHasVisibleBlocks([stepsNoDuration], true)).toBe(true);
    expect(messageHasVisibleBlocks([stepsNoDuration], false)).toBe(false);
    expect(messageHasVisibleBlocks([textBlock], false)).toBe(true);
  });
});

describe("tool-only narration", () => {
  it("is true for a live run that has only called tools, and for a steps-only message", () => {
    expect(isToolOnlyNarration([liveActivity, stepsBlock], true)).toBe(true);
    expect(isToolOnlyNarration([stepsBlock], true)).toBe(true);
    expect(isToolOnlyNarration([stepsBlock, stepsNoDuration], true)).toBe(true);
  });

  it("is false once the bot has written something, or when tool cards are hidden", () => {
    expect(isToolOnlyNarration([stepsBlock, textBlock], true)).toBe(false);
    expect(isToolOnlyNarration([narration, liveActivity, stepsBlock], true)).toBe(false);
    expect(isToolOnlyNarration([liveActivity, stepsBlock], false)).toBe(false);
    expect(isToolOnlyNarration([liveActivity], true)).toBe(false);
  });
});
