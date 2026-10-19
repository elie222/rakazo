import type { TranscriptContext } from "@earendil-works/pi-ai";

/**
 * Claude 5.5 binds each signed thinking block to the conversation prefix it was written in.
 * Rakazo rewrites earlier history between requests (pruned screenshots and page state,
 * changed tools), so a replayed block can stop matching and the provider rejects the whole
 * request: "Invalid `signature` in `thinking` block. The block is bound to a different
 * conversation." Retrying the same history fails the same way, so the thread stays broken.
 * Anthropic can drop such blocks itself (thinking.block_binding), but proxies like OpenCode
 * reject that field, so the runtime retries without the earlier thinking instead.
 */
const MISMATCHED_SIGNATURE =
  /invalid `?signature`? in `?thinking`? block|bound to a different conversation/i;

export function isThinkingSignatureMismatch(errorMessage: string | undefined): boolean {
  return !!errorMessage && MISMATCHED_SIGNATURE.test(errorMessage);
}

/** The context with thinking blocks removed from earlier assistant messages. */
export function withoutThinkingBlocks(context: TranscriptContext): TranscriptContext {
  let changed = false;
  const messages = context.messages.map((message) => {
    if (message.role !== "assistant") return message;
    const content = message.content.filter((part) => part.type !== "thinking");
    if (content.length === message.content.length) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? { ...context, messages } : context;
}
