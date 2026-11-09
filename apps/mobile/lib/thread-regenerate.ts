import { resolveComposerSendPlan, selectableMessageText } from "@rakazo/core";
import type { MobileMessage } from "./mobile-types";
import type { SendPayload } from "./thread-feedback";

/**
 * The user message a bot reply answers: the nearest user message before it.
 * Returns null when the reply has no user message above it.
 */
export function previousUserMessageText(
  messages: readonly MobileMessage[],
  botMessageId: string,
): string | null {
  const index = messages.findIndex((message) => message.id === botMessageId);
  const before = index === -1 ? messages : messages.slice(0, index);
  for (let i = before.length - 1; i >= 0; i--) {
    const message = before[i]!;
    if (message.role !== "user") continue;
    const text = selectableMessageText(message).trim();
    if (text) return text;
  }
  return null;
}

/**
 * A regenerate is a plain resend of that user message through the normal outbox,
 * so it runs the same send path as a message typed in the composer.
 *
 * NOTE: there is no server-side regenerate, so this adds a second copy of the
 * user's message to the thread; the maintainer decides whether that is acceptable.
 */
export function buildRegeneratePayload({
  text,
  originThreadKey,
  botTarget,
  groupTarget,
}: {
  text: string;
  originThreadKey: string;
  botTarget?: string;
  groupTarget?: string;
}): SendPayload {
  return {
    originThreadKey,
    displayText: text,
    replyPreview: null,
    initialBotTarget: botTarget,
    botTarget,
    groupTarget,
    reroutedToGroup: false,
    plan: resolveComposerSendPlan({ text, mentions: [], hasAttachments: false }),
    attachments: [],
    replyQuote: null,
  };
}
