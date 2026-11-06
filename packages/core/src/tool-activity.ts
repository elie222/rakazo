import type { MessageBlock, ToolStep } from "@rakazo/contracts";

/** While a run is live, only the most recent steps are listed so a long run does not push the chat down. */
export const LIVE_TOOL_STEP_WINDOW = 6;

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
