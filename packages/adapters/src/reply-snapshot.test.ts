import type { Run } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { restoreReply, snapshotReply } from "./reply-snapshot.js";
import { createReplyState } from "./run-progress.js";

const freshReply = () =>
  createReplyState(
    { prisma: { message: { findMany: async () => [] } } } as unknown as ExecutorDeps,
    { id: "run-1", startedAt: new Date("2026-01-01T00:00:00Z") } as unknown as Run,
    [],
  );

describe("a reply saved with a handed-back turn", () => {
  it("continues in the next attempt with its steps, kept calls and held notes", async () => {
    const before = await freshReply();
    before.messageSegments = [{ kind: "steps", steps: [{ label: "List files", count: 1 }] }];
    before.toolCalls.push({ label: "List files", executionId: "call-1", tool: "list_files" });
    before.toolOutcomes.set("call-1", "succeeded");
    before.toolStepCalls.set("call-1", { arguments: '{"path":"."}', result: "a.txt" });
    before.keptResultChars = 5;
    before.workingNotes.push("Looking at the files.");
    before.narrationSoFar = "Looking at the files.";
    before.assistantTurnBreakPending = true;
    before.latestScreenshot = {
      executionId: "call-1",
      mimeType: "image/png",
      data: new Uint8Array([1, 2, 3]),
    };

    const after = await freshReply();
    restoreReply(after, JSON.parse(JSON.stringify(snapshotReply(before))));

    expect(after.messageSegments).toEqual(before.messageSegments);
    expect(after.toolCalls).toEqual(before.toolCalls);
    expect(after.toolOutcomes).toEqual(before.toolOutcomes);
    expect(after.toolStepCalls).toEqual(before.toolStepCalls);
    expect(after.keptResultChars).toBe(5);
    expect(after.workingNotes).toEqual(["Looking at the files."]);
    expect(after.narrationSoFar).toBe("Looking at the files.");
    expect(after.assistantTurnBreakPending).toBe(true);
    expect(after.latestScreenshot).toEqual(before.latestScreenshot);
  });

  it("keeps the answer allowance, steering limits and turn clock of the saved turn", async () => {
    const before = await freshReply();
    before.steeringReplyPending = true;
    before.steeringResets = 2;
    before.lastSteeringResetAt = 1_700_000_060_000;
    before.turnStartedAtMs = 1_700_000_000_000;

    const after = await freshReply();
    restoreReply(after, JSON.parse(JSON.stringify(snapshotReply(before))));

    expect(after.steeringReplyPending).toBe(true);
    expect(after.steeringResets).toBe(2);
    expect(after.lastSteeringResetAt).toBe(1_700_000_060_000);
    expect(after.turnStartedAtMs).toBe(1_700_000_000_000);
  });

  it("keeps the fresh attempt's allowance, limits and clock for a reply saved without them", async () => {
    const before = await freshReply();
    const {
      steeringReplyPending: _pending,
      steeringResets: _resets,
      lastSteeringResetAt: _lastReset,
      turnStartedAtMs: _started,
      ...older
    } = snapshotReply(before);
    const after = await freshReply();
    restoreReply(after, JSON.parse(JSON.stringify(older)));

    expect(after.steeringReplyPending).toBe(false);
    expect(after.steeringResets).toBe(0);
    expect(after.lastSteeringResetAt).toBe(Number.NEGATIVE_INFINITY);
    expect(after.turnStartedAtMs).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("starts the reply empty when the saved turn has none or one it cannot read", async () => {
    const empty = await freshReply();
    for (const saved of [undefined, { version: 2 }, "steps"]) {
      const reply = await freshReply();
      restoreReply(reply, saved);
      expect(snapshotReply(reply)).toEqual(snapshotReply(empty));
    }
  });
});
