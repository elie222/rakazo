import { describe, expect, it } from "vitest";
import { createReplyState, recordToolOutcome, toolCallResultFields } from "./run-progress.js";

async function reply() {
  const deps = { prisma: { message: { findMany: async () => [] } } };
  const run = { id: "run-1", startedAt: null };
  return createReplyState(deps as never, run as never, []);
}

describe("recordToolOutcome", () => {
  it("marks a pending call and a published step", async () => {
    const state = await reply();
    state.pendingTools.push({ name: "shell", executionId: "x1" });
    state.messageSegments = [
      { kind: "steps", steps: [{ label: "Read file", count: 1, executionId: "x0" }] },
    ];
    recordToolOutcome(state, "x1", "error", 12.6);
    recordToolOutcome(state, "x0", "ok", 3);
    expect(state.pendingTools).toEqual([
      { name: "shell", executionId: "x1", outcome: "error", durationMs: 13 },
    ]);
    expect(state.messageSegments).toEqual([
      {
        kind: "steps",
        steps: [{ label: "Read file", count: 1, executionId: "x0", outcome: "ok", durationMs: 3 }],
      },
    ]);
    expect(state.earlyToolOutcomes.size).toBe(0);
    expect(toolCallResultFields(state, "x1")).toEqual({ outcome: "error", durationMs: 13 });
    expect(toolCallResultFields(state, "x0")).toEqual({ outcome: "ok", durationMs: 3 });
    expect(toolCallResultFields(state, "none")).toEqual({});
  });

  it("holds the result of a call whose step is not queued yet", async () => {
    const state = await reply();
    recordToolOutcome(state, "fast", "ok", 2);
    expect(state.pendingTools).toEqual([]);
    expect(state.earlyToolOutcomes.get("fast")).toEqual({ outcome: "ok", durationMs: 2 });
  });
});
