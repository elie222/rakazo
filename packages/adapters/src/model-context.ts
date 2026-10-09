import type { Context } from "@earendil-works/pi-ai";
import type { ContextBudget } from "./context-selection.js";
import { estimateContextTokens } from "./context-selection.js";

/**
 * Conservative fallback for an unknown tokenizer: one token per UTF-8 byte,
 * including tool schemas and message framing. When an adapter supplies a
 * dimension-based image planning estimate, use it for actual image blocks only.
 * Unknown images keep the byte fallback.
 */
export function estimateModelContextTokens(
  context: Context,
  imageTokens?: ContextBudget["imageTokens"],
): number {
  return estimateContextTokens(context, imageTokens) + 240;
}
