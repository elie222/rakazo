import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { isToolActivityBlock, toolStepStatus } from "./tool-activity.js";

describe("tool activity", () => {
  it.each<MessageBlock>([
    { kind: "steps", steps: [{ label: "Browser", count: 1 }] },
    { kind: "progress", text: "Using browser", activity: true },
    { kind: "progress", text: "Using brex: list_expenses", activity: true },
  ])("recognizes $kind activity", (block) => {
    expect(isToolActivityBlock(block)).toBe(true);
  });

  it("keeps assistant narration separate from tool activity", () => {
    expect(isToolActivityBlock({ kind: "progress", text: "I’m checking that now." })).toBe(false);
    expect(isToolActivityBlock({ kind: "progress", text: "Using browser" })).toBe(false);
    expect(
      isToolActivityBlock({
        kind: "progress",
        text: "Let me check",
        pendingTools: [{ name: "browser" }],
      }),
    ).toBe(false);
    expect(
      isToolActivityBlock({ kind: "progress", text: "Using the search results, I found it." }),
    ).toBe(false);
    expect(
      isToolActivityBlock({
        kind: "progress",
        text: "Using the search results, I found…",
      }),
    ).toBe(false);
    expect(
      isToolActivityBlock({
        kind: "progress",
        text: "Using these notes, here is a summary.",
      }),
    ).toBe(false);
    expect(isToolActivityBlock({ kind: "text", text: "Done." })).toBe(false);
  });
});

describe("toolStepStatus", () => {
  it("reads a failed call as an error and an unfinished one as running only while live", () => {
    expect(toolStepStatus({ outcome: "error" }, true)).toBe("error");
    expect(toolStepStatus({ outcome: "ok" }, true)).toBe("ok");
    expect(toolStepStatus({}, true)).toBe("running");
    expect(toolStepStatus({}, false)).toBe("ok");
  });
});
