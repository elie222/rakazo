import type { MessageBlock } from "@rakazo/contracts";
import { TAKEOVER_COMPUTER_PENDING_STATE } from "../threads/thread-message-updates.js";
import { isQuestionAskBlock } from "./ask-replies.js";

/** What a chat app adds to a pending question it cannot show as a card. */
export const CHAT_APP_ASK_NOTE = "(Answer in the app.)";

/**
 * How a still-pending question reads in a 1:1 chat app, which cannot show cards: the question,
 * its detail, and its options numbered in order, then where to answer it. Any other request, such
 * as an approval, a secret or an instruction change, keeps to its title: only its card can answer
 * it, and its detail can hold a command, a diff or tool input. An answered one adds nothing.
 */
export function chatAppAskText(
  block: MessageBlock,
  options: { appUrl?: string } = {},
): string | undefined {
  if (block.kind !== "ask" || block.status === "answered") return undefined;
  const lines = isQuestionAskBlock(block)
    ? [
        block.detail?.trim(),
        ...(block.actions ?? []).map((action, index) => `${index + 1}. ${action.label}`),
      ]
    : [];
  const note = chatAppAskNote(options.appUrl, isQuestionAskBlock(block));
  return [block.text.trim(), ...lines, note].filter(Boolean).join("\n");
}

/**
 * Where to answer an ask. With the bot's chat in the app, the note links to it, so an ask sent
 * to a chat app is one tap from its card. Only an http(s) link is used.
 */
export function chatAppAskNote(appUrl?: string, question = false): string {
  if (!appUrl || !/^https?:\/\//.test(appUrl)) return CHAT_APP_ASK_NOTE;
  // The link ends the line on its own, so chat apps make it tappable.
  return question
    ? `To answer, open the app: ${appUrl}`
    : `To approve or decline, open the app: ${appUrl}`;
}

/** What a chat app adds to a request to take over the bot's computer screen. */
export const CHAT_APP_TAKEOVER_NOTE = "(Take over the screen in the app.)";

/**
 * A pending takeover request in a 1:1 chat app. The screen can only be used in the app, so the
 * line says what is asked and where to do it.
 */
export function chatAppTakeoverText(block: {
  kind: string;
  state?: string;
  text?: string;
}): string | undefined {
  if (block.kind !== "computer" || block.state !== TAKEOVER_COMPUTER_PENDING_STATE)
    return undefined;
  return [block.text?.trim(), CHAT_APP_TAKEOVER_NOTE].filter(Boolean).join("\n");
}
