import type { Context } from "@earendil-works/pi-ai";
import { isRecord } from "@rakazo/core";
import type { ContextBudget } from "../runtime/context/context-selection.js";
import { estimateContextTokens } from "../runtime/context/context-selection.js";

/**
 * Strip internal watch-check delivery provenance from tool-result `details` before sizing a
 * request: providers never receive `details`, so checkpoint metadata must not inflate estimates
 * or disqualify a usable backup model.
 */
function withoutWatchProvenanceDetails(context: Context): Context {
  let changed = false;
  const messages = context.messages.map((message) => {
    if (message.role !== "toolResult" || !isRecord(message.details)) return message;
    if (
      !("contextBeforeUseText" in message.details) &&
      !("contextDeliveredTexts" in message.details)
    ) {
      return message;
    }
    const {
      contextBeforeUseText: _beforeUse,
      contextDeliveredTexts: _delivered,
      ...restDetails
    } = message.details;
    changed = true;
    return { ...message, details: restDetails };
  });
  return changed ? { ...context, messages } : context;
}

/**
 * Provider-neutral estimate for an unknown tokenizer, including tool schemas and
 * message framing. Image blocks use the adapter's dimension-based planning estimate
 * when one is supplied and a serialized byte count otherwise.
 */
export function estimateModelContextTokens(
  context: Context,
  imageTokens?: ContextBudget["imageTokens"],
): number {
  return estimateContextTokens(withoutWatchProvenanceDetails(context), imageTokens) + 240;
}
