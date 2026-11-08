import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  formatElapsedSince,
  isToolActivityBlock,
  pickToolCallRecord,
  toolCallReadIsFinal,
  toolStepStatus,
} from "./tool-activity.js";

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

describe("pickToolCallRecord", () => {
  it("retains fetched arguments when only the live completion arrived", () => {
    const read = { executionId: "x", name: "read_file", status: "running" as const, input: "{}" };
    const live = { executionId: "x", name: "read_file", status: "done" as const, output: "result" };
    expect(pickToolCallRecord(live, undefined, true)).toEqual({ record: live, needsRead: true });
    expect(pickToolCallRecord(live, read, true).record).toEqual({ ...read, ...live });
  });

  const live = { executionId: "x1", name: "shell", status: "running" } as const;
  const read = { executionId: "x1", name: "shell", status: "done", outcome: "succeeded" } as const;

  it("shows the live record while the run is live and reads only without one", () => {
    expect(pickToolCallRecord(live, undefined, true)).toEqual({ record: live, needsRead: false });
    expect(pickToolCallRecord(undefined, read, true)).toEqual({ record: read, needsRead: true });
    expect(pickToolCallRecord(undefined, undefined, false)).toEqual({
      record: undefined,
      needsRead: true,
    });
  });

  it("reads past a live record the run ended without finishing, and shows the read once it has one", () => {
    expect(pickToolCallRecord(live, undefined, false)).toEqual({ record: live, needsRead: true });
    expect(pickToolCallRecord(live, read, false)).toEqual({ record: read, needsRead: true });
    const done = { ...live, status: "done", command: "ls" } as const;
    expect(pickToolCallRecord(done, read, false)).toEqual({ record: done, needsRead: false });
  });
});

describe("formatElapsedSince", () => {
  it("formats the time since a start and nothing for a missing or unreadable one", () => {
    const now = Date.parse("2026-01-01T00:01:05.000Z");
    expect(formatElapsedSince("2026-01-01T00:00:00.000Z", now)).toBe("1m 05s");
    expect(formatElapsedSince("2026-01-01T00:02:00.000Z", now)).toBe("0ms");
    expect(formatElapsedSince(undefined, now)).toBeNull();
    expect(formatElapsedSince("not a date", now)).toBeNull();
  });
});

describe("toolCallReadIsFinal", () => {
  it("lets a read stand once it has the call and nothing in it was still running", () => {
    const done = { executionId: "x1", name: "shell", status: "done" } as const;
    expect(toolCallReadIsFinal([done], "x1")).toBe(true);
    expect(toolCallReadIsFinal([done], "x2")).toBe(false);
    expect(
      toolCallReadIsFinal([done, { ...done, executionId: "x2", status: "running" }], "x1"),
    ).toBe(false);
    expect(toolCallReadIsFinal(undefined, "x1")).toBe(false);
  });
});
