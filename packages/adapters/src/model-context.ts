import type { Context } from "@earendil-works/pi-ai";

/**
 * Conservative fallback for an unknown tokenizer: one token per UTF-8 byte,
 * including tool schemas and message framing. Inline image bytes are counted too;
 * this deliberately over-reserves rather than guessing a provider's image pricing.
 */
export function estimateModelContextTokens(context: Context): number {
  return Buffer.byteLength(JSON.stringify(context), "utf8") + 256;
}
