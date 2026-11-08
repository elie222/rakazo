import type { MessageBlock, ToolCallRecord, ToolStep } from "@rakazo/contracts";
import { humanizeToolName } from "./events.js";
import { formatCompactDuration } from "./routine-runs.js";

/** While a run is live, only the most recent steps are listed so a long run does not push the chat down. */
export const LIVE_TOOL_STEP_WINDOW = 6;

/** Visual action arguments or results may contain typed credentials that the run never saw. */
export function isVisualActionTool(name: string): boolean {
  return name === "browser_act" || name === "computer_act" || name === "user_computer_act";
}

const SHELL_STEP_LABELS = new Set(["shell", "user_computer_shell"].map(humanizeToolName));

/** Older replies may have saved private arguments as shared step details. */
export function withoutPrivateStepDetails(blocks: MessageBlock[]): MessageBlock[] {
  return blocks.map((block) => {
    if (block.kind !== "steps") return block;
    return {
      ...block,
      steps: block.steps?.map((step) => {
        if (step.detail === undefined || SHELL_STEP_LABELS.has(step.label)) return step;
        const { detail: _detail, ...safe } = step;
        return safe;
      }),
    };
  });
}

export type ToolStepStatus = "running" | "ok" | "error";

/**
 * How a step row reads: a failed call shows as such; one still without a result is running
 * while the run is live. A finished run's step with no recorded result reads as done, which
 * also keeps replies saved before results were recorded looking as they did.
 */
export function toolStepStatus(step: Pick<ToolStep, "outcome">, live: boolean): ToolStepStatus {
  if (step.outcome === "error") return "error";
  if (step.outcome === undefined && live) return "running";
  return "ok";
}

/** Undo empties the checklist as well as marking it, so older clients hide it too. */
export function isRetiredImportSetup(block: MessageBlock): boolean {
  return block.kind === "import_setup" && (block.undone === true || block.items.length === 0);
}

export function isToolActivityBlock(block: MessageBlock): boolean {
  return block.kind === "steps" || (block.kind === "progress" && block.activity === true);
}

/** Where a device keeps whether it shows tool activity. */
export const TOOL_ACTIVITY_STORAGE_KEY = "rakazo.showToolActivity";

export type ToolActivityPreference = "on" | "off";

/** Only a saved "on" shows tool cards. Missing or unreadable storage stays off so chats stay clean. */
export function normalizeToolActivityPreference(
  raw: string | null | undefined,
): ToolActivityPreference {
  return raw?.trim().toLowerCase() === "on" ? "on" : "off";
}

/**
 * Which record an opened step shows: the live one while the thread's events carry it, else one
 * read from the run's events. A live record left unfinished by a run that has ended is stale
 * (the client missed its result), so a read is needed and wins once it has one.
 */
export function pickToolCallRecord(
  live: ToolCallRecord | undefined,
  read: ToolCallRecord | undefined,
  runLive: boolean,
): { record: ToolCallRecord | undefined; needsRead: boolean } {
  const stale = live !== undefined && !runLive && live.status !== "done";
  const record = stale ? (read ?? live) : (live ?? read);
  const missingCall =
    live?.status === "done" &&
    !live.withheld &&
    live.input === undefined &&
    live.command === undefined &&
    !isVisualActionTool(live.name);
  const retainedInput =
    live && !stale && !live.withheld && live.input === undefined ? read?.input : undefined;
  return {
    record: record && retainedInput !== undefined ? { ...record, input: retainedInput } : record,
    needsRead: live === undefined || stale || missingCall,
  };
}

/** Time since a run's first activity as the compact duration the step rows use; null without a valid start. */
export function formatElapsedSince(startedAt: string | undefined, nowMs: number): string | null {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isFinite(started) ? formatCompactDuration(Math.max(0, nowMs - started)) : null;
}

/**
 * Whether a read of a finished run's calls can stand for it from now on: it has this call, and
 * none of its calls was still running when it was read. A read taken mid-run fails one or the
 * other and is read again.
 */
export function toolCallReadIsFinal(
  records: readonly ToolCallRecord[] | undefined,
  executionId: string,
): boolean {
  return (
    !!records?.some((record) => record.executionId === executionId) &&
    records.every((record) => record.status !== "running")
  );
}
