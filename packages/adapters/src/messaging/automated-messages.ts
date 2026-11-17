import { TOOL_IMAGES_LABEL, TOOL_IMAGES_TEXT } from "./automated-messages.prompt.js";

type Part = { type?: unknown; text?: unknown };

/**
 * Relabel those screenshot messages in an OpenAI-style request payload. Returns a new
 * payload when something changed, otherwise undefined (pi-ai then keeps its own).
 */
export function relabelToolImageMessages(payload: unknown): unknown {
  const messages = (payload as { messages?: unknown } | null | undefined)?.messages;
  if (!Array.isArray(messages)) return undefined;
  let changed = false;
  const next = messages.map((message: { role?: unknown; content?: unknown }) => {
    if (message?.role !== "user" || !Array.isArray(message.content)) return message;
    const [first, ...rest] = message.content as Part[];
    if (first?.type !== "text" || first.text !== TOOL_IMAGES_TEXT) return message;
    changed = true;
    return { ...message, content: [{ ...first, text: TOOL_IMAGES_LABEL }, ...rest] };
  });
  return changed ? { ...(payload as object), messages: next } : undefined;
}

type PayloadHook = (payload: unknown, model: never) => unknown;

/** Stream options with the relabel step added after any onPayload hook already there. */
export function withAutomatedLabels<O extends object>(options: O | undefined): O {
  const previous = (options as { onPayload?: PayloadHook } | undefined)?.onPayload;
  return {
    ...(options ?? {}),
    onPayload: async (payload: unknown, model: never) => {
      const replaced = previous ? await previous(payload, model) : undefined;
      return relabelToolImageMessages(replaced ?? payload) ?? replaced;
    },
  } as O;
}
