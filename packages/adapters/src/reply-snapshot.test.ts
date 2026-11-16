import type { Run } from "@rakazo/db";
import * as Logging from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { restoreReply, snapshotReply } from "./reply-snapshot.js";
import { createReplyState } from "./run-progress.js";

const freshReply = () =>
  createReplyState(
    { prisma: { message: { findMany: async () => [] } } } as unknown as ExecutorDeps,
    { id: "run-1", startedAt: new Date("2026-01-01T00:00:00Z") } as unknown as Run,
    [],
  );

function captureLogs() {
  const logger = { warn: vi.fn(), error: vi.fn() };
  vi.spyOn(Logging, "getLogger").mockReturnValue(logger as never);
  return logger;
}

describe("a reply saved with a handed-back turn", () => {
  afterEach(() => vi.restoreAllMocks());

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
    restoreReply(after, JSON.parse(JSON.stringify(snapshotReply(before))), "run-1");

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
    restoreReply(after, JSON.parse(JSON.stringify(snapshotReply(before))), "run-1");

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
    const logs = captureLogs();
    restoreReply(after, JSON.parse(JSON.stringify(older)), "run-older");

    expect(logs.error).not.toHaveBeenCalled();
    expect(logs.warn).not.toHaveBeenCalled();

    expect(after.steeringReplyPending).toBe(false);
    expect(after.steeringResets).toBe(0);
    expect(after.lastSteeringResetAt).toBe(Number.NEGATIVE_INFINITY);
    expect(after.turnStartedAtMs).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("starts the reply empty when the saved turn has none", async () => {
    const empty = await freshReply();
    const reply = await freshReply();
    const logs = captureLogs();
    restoreReply(reply, undefined, "run-none");

    expect(snapshotReply(reply)).toEqual(snapshotReply(empty));
    expect(logs.error).not.toHaveBeenCalled();
  });

  it("reports a saved reply it cannot read as an error, without its content, and starts empty", async () => {
    const empty = await freshReply();
    const unreadable = {
      ...JSON.parse(JSON.stringify(snapshotReply(empty))),
      version: 2,
      assembled: 42,
      narrationSoFar: undefined,
      workingNotes: ["private note"],
    };
    for (const [runId, saved, expected] of [
      [
        "run-unreadable",
        unreadable,
        { shape: "object", version: "2", issuePaths: "version, assembled, narrationSoFar" },
      ],
      ["run-text", "private text", { shape: "string", issuePaths: "(root)" }],
    ] as const) {
      const reply = await freshReply();
      const logs = captureLogs();
      restoreReply(reply, saved, runId);

      expect(snapshotReply(reply)).toEqual(snapshotReply(empty));
      expect(logs.error).toHaveBeenCalledOnce();
      const [, detail] = logs.error.mock.calls[0] ?? [];
      expect(detail).toEqual({
        table: "external_effects",
        column: "result",
        id: JSON.stringify(["runtime_checkpoint", runId]),
        ...expected,
      });
      expect(JSON.stringify(detail)).not.toContain("private");
      vi.restoreAllMocks();
    }
  });
});
