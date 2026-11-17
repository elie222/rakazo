import { MessageBlock, storedImageMimeType, ToolStepCallSchema } from "@rakazo/contracts";
import { reportJsonColumnOnce, runTurnCheckpointRow } from "@rakazo/db";
import { z } from "zod";
import type { ReplyState } from "./run-context.js";

const ReplySnapshotSchema = z.object({
  version: z.literal(1),
  assembled: z.string(),
  currentTextSegment: z.string(),
  messageSegments: z.array(MessageBlock),
  pendingToolNames: z.array(z.string()),
  toolCalls: z.array(
    z.object({ label: z.string(), executionId: z.string(), tool: z.string().optional() }),
  ),
  toolOutcomes: z.array(z.tuple([z.string(), z.enum(["succeeded", "failed", "stopped"])])),
  toolStepCalls: z.array(z.tuple([z.string(), ToolStepCallSchema])),
  keptResultChars: z.number(),
  latestScreenshot: z
    .object({ executionId: z.string(), mimeType: z.string(), data: z.string() })
    .optional(),
  workingNotes: z.array(z.string()),
  narrationSoFar: z.string(),
  textSinceLastStep: z.string(),
  discardedMidTurnNarration: z.boolean(),
  lastDiscardedMidTurnNarration: z.string(),
  explicitNoResponse: z.boolean(),
  publishedTerminalSubagent: z.boolean(),
  computerTaskStarted: z.boolean(),
  assistantTurnBreakPending: z.boolean(),
  progressBudgetStart: z.number(),
  // Added after the first release of this snapshot, so a saved reply without them keeps the
  // fresh attempt's values. Times are wall-clock milliseconds, the same on any process.
  steeringReplyPending: z.boolean().optional(),
  steeringResets: z.number().optional(),
  lastSteeringResetAt: z.number().optional(),
  turnStartedAtMs: z.number().optional(),
});
export type ReplySnapshot = z.infer<typeof ReplySnapshotSchema>;

/**
 * What a turn handed back between steps, or paused for an answer, approval or takeover, has built
 * of its reply, saved with its checkpoint. The resumed attempt reruns none of those steps, so it
 * finishes the reply from here.
 */
export function snapshotReply(reply: ReplyState): ReplySnapshot {
  const shot = reply.latestScreenshot;
  return {
    version: 1,
    assembled: reply.assembled,
    currentTextSegment: reply.currentTextSegment,
    messageSegments: reply.messageSegments,
    pendingToolNames: reply.pendingToolNames,
    toolCalls: reply.toolCalls,
    toolOutcomes: [...reply.toolOutcomes],
    toolStepCalls: [...reply.toolStepCalls],
    keptResultChars: reply.keptResultChars,
    ...(shot && {
      latestScreenshot: {
        executionId: shot.executionId,
        mimeType: shot.mimeType,
        data: Buffer.from(shot.data).toString("base64"),
      },
    }),
    workingNotes: reply.workingNotes,
    narrationSoFar: reply.narrationSoFar,
    textSinceLastStep: reply.textSinceLastStep,
    discardedMidTurnNarration: reply.discardedMidTurnNarration,
    lastDiscardedMidTurnNarration: reply.lastDiscardedMidTurnNarration,
    explicitNoResponse: reply.explicitNoResponse,
    publishedTerminalSubagent: reply.publishedTerminalSubagent,
    computerTaskStarted: reply.computerTaskStarted,
    assistantTurnBreakPending: reply.assistantTurnBreakPending,
    progressBudgetStart: reply.progressBudgetStart,
    steeringReplyPending: reply.steeringReplyPending,
    steeringResets: reply.steeringResets,
    // Never reset is -Infinity, which JSON cannot hold.
    ...(Number.isFinite(reply.lastSteeringResetAt) && {
      lastSteeringResetAt: reply.lastSteeringResetAt,
    }),
    turnStartedAtMs: reply.turnStartedAtMs,
  };
}

/**
 * Continues the reply a handed-back or paused attempt saved. A checkpoint without one (an older
 * release) starts the reply empty, as before. One this release cannot read is reported as an
 * error and also starts empty: its steps are lost, and nothing better is left to restore.
 */
export function restoreReply(reply: ReplyState, saved: unknown, runId: string): void {
  if (saved === undefined) return;
  const parsed = ReplySnapshotSchema.safeParse(saved);
  if (!parsed.success) {
    reportJsonColumnOnce(
      "saved reply of a handed-back turn is unreadable; resuming with an empty reply",
      runTurnCheckpointRow(runId),
      describeMismatch(saved, parsed.error.issues),
    );
    return;
  }
  const { latestScreenshot, toolOutcomes, toolStepCalls, version: _, ...rest } = parsed.data;
  Object.assign(reply, rest);
  reply.toolOutcomes = new Map(toolOutcomes);
  reply.toolStepCalls = new Map(toolStepCalls);
  const mimeType = latestScreenshot && storedImageMimeType(latestScreenshot.mimeType);
  if (latestScreenshot && mimeType)
    reply.latestScreenshot = {
      executionId: latestScreenshot.executionId,
      mimeType,
      data: new Uint8Array(Buffer.from(latestScreenshot.data, "base64")),
    };
}

function describeMismatch(
  saved: unknown,
  issues: readonly { path: readonly PropertyKey[] }[],
): Record<string, string> {
  const shape = Array.isArray(saved) ? "array" : saved === null ? "null" : typeof saved;
  const version = (saved as { version?: unknown } | null)?.version;
  return {
    shape,
    ...(typeof version === "number" && { version: String(version) }),
    issuePaths: issues.map((issue) => issue.path.map(String).join(".") || "(root)").join(", "),
  };
}
