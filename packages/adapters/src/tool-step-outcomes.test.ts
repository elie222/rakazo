import { appendToolCallSegment } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import type { ReplyState } from "./run-context.js";
import { withReplyToolOutcomes } from "./run-progress.js";
import { toolCompletionOutcome } from "./tool-completion-audit.js";

const base = { name: "shell", executionId: "call-1", durationMs: 5 };

describe("tool step outcomes", () => {
  it("reads success, a thrown or reported error, and a pause from a completion", () => {
    expect(toolCompletionOutcome({ ...base, result: { content: [] } })).toBe("succeeded");
    expect(toolCompletionOutcome({ ...base, error: new Error("boom") })).toBe("failed");
    expect(
      toolCompletionOutcome({
        ...base,
        result: { content: [{ type: "text", text: "no" }], details: { isError: true } },
      }),
    ).toBe("failed");
    expect(toolCompletionOutcome({ ...base, paused: true })).toBeUndefined();
  });

  it("fails a command that ran but exited non-zero", () => {
    const shell = (code: number) => ({ ...base, result: { stdout: "", stderr: "x", code } });
    expect(toolCompletionOutcome(shell(0))).toBe("succeeded");
    expect(toolCompletionOutcome(shell(1))).toBe("failed");
    expect(toolCompletionOutcome(shell(127))).toBe("failed");
    expect(
      toolCompletionOutcome({ ...base, result: { content: [], details: { exitCode: 2 } } }),
    ).toBe("failed");
  });

  it("saves each call's outcome on its step, and counts unfinished calls when stopped", () => {
    const reply = {
      messageSegments: appendToolCallSegment(appendToolCallSegment([], "shell"), "shell"),
      toolCalls: [
        { label: "Shell", executionId: "call-1" },
        { label: "Shell", executionId: "call-2" },
      ],
      toolOutcomes: new Map([["call-1", "succeeded" as const]]),
    } as unknown as ReplyState;
    expect(withReplyToolOutcomes(reply)).toEqual([
      { kind: "steps", steps: [{ label: "Shell", count: 2, outcomes: { succeeded: 1 } }] },
    ]);
    expect(withReplyToolOutcomes(reply, "stopped")).toEqual([
      {
        kind: "steps",
        steps: [{ label: "Shell", count: 2, outcomes: { succeeded: 1, stopped: 1 } }],
      },
    ]);
  });
});
