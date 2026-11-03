import type { TranscriptContext } from "@earendil-works/pi-ai";

/**
 * Claude 5.5 binds each signed thinking block to the conversation prefix it was written in, and
 * Rakazo rewrites earlier history between requests, so a replayed block can make the provider
 * reject the whole request. Anthropic can drop such blocks itself (thinking.block_binding), but
 * proxies like OpenCode reject that field, so the runtime retries without the earlier thinking.
 */
const MISMATCHED_SIGNATURE =
  /invalid `?signature`? in `?thinking`? block|bound to a different conversation/i;

export function isThinkingSignatureMismatch(errorMessage: string | undefined): boolean {
  return !!errorMessage && MISMATCHED_SIGNATURE.test(errorMessage);
}

/** The context with thinking blocks removed from earlier assistant messages. */
export function withoutThinkingBlocks(context: TranscriptContext): TranscriptContext {
  const messages = withoutThinkingFrom(context.messages, 0);
  return messages === context.messages ? context : { ...context, messages };
}

/** The messages with thinking blocks removed from assistant messages from `from` up to `to`. */
export function withoutThinkingFrom<T extends TranscriptContext["messages"][number]>(
  messages: T[],
  from: number,
  to = messages.length,
): T[] {
  let changed = false;
  const result = messages.map((message, index) => {
    if (index < from || index >= to || message.role !== "assistant") return message;
    const content = message.content.filter((part) => part.type !== "thinking");
    if (content.length === message.content.length) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? result : messages;
}
