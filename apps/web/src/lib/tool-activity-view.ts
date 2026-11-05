import type { MessageBlock, ToolStep } from "@rakazo/contracts";
import { isRetiredImportSetup, isToolActivityBlock } from "@rakazo/core";

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

/** Number of tool calls behind a steps block: the sum of each row's count. */
export function toolStepCount(steps: readonly { count: number }[]): number {
  return steps.reduce((total, step) => total + step.count, 0);
}

/**
 * Only a `steps` block becomes a card, and only when the preference is on.
 * A `progress` block marked `activity: true` never renders, in either mode.
 */
export function shouldRenderToolCard(block: MessageBlock, showToolActivity: boolean): boolean {
  return showToolActivity && block.kind === "steps";
}

/** Blocks that survive into a message render. */
export function renderableMessageBlocks(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
): MessageBlock[] {
  return blocks.filter((block) => isShown(block, showToolActivity));
}

function isShown(block: MessageBlock, showToolActivity: boolean): boolean {
  if (isRetiredImportSetup(block)) return false;
  return !isToolActivityBlock(block) || shouldRenderToolCard(block, showToolActivity);
}

/**
 * True when a bot message's only visible blocks are tool cards, such as a live run that
 * has called tools but not written anything yet. Such a message renders as slim lines
 * between messages instead of inside a chat bubble.
 */
export function isToolOnlyNarration(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
): boolean {
  const visible = renderableMessageBlocks(blocks, showToolActivity);
  return visible.length > 0 && visible.every((block) => block.kind === "steps");
}

/** True when a message still has at least one block to show under the preference. */
export function messageHasVisibleBlocks(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
): boolean {
  return blocks.some((block) => isShown(block, showToolActivity));
}
