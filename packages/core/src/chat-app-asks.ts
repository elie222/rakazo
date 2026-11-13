import type { MessageBlock } from "@rakazo/contracts";
import { resolveAskChoice } from "./answerable-ask.js";
import { isQuestionAskBlock } from "./ask-replies.js";
import { TAKEOVER_COMPUTER_PENDING_STATE } from "./thread-message-updates.js";

/** What a chat app adds to a pending question only its card can answer. */
export const CHAT_APP_ASK_NOTE = "(Answer in the app.)";
/** What a chat app adds to a pending question with options a reply can pick. */
export const CHAT_APP_CHOICE_NOTE = "(Reply with a number or your own answer.)";
/** What a chat app adds to a pending open question. */
export const CHAT_APP_REPLY_NOTE = "(Reply to answer.)";

/**
 * A pending question a chat-app reply can answer, as the app's composer can: a conversational
 * question, not an approval, a secret or an instruction change, which only their cards answer.
 */
export function chatAppAnswersAsk(block: MessageBlock): boolean {
  return block.kind === "ask" && block.status !== "answered" && isQuestionAskBlock(block);
}

/**
 * How a still-pending question reads in a 1:1 chat app, which cannot show cards: the question,
 * its detail, and its options numbered in order, then how to answer it. Any other request, such
 * as an approval, a secret or an instruction change, keeps to its title: only its card can answer
 * it, and its detail can hold a command, a diff or tool input. An answered one adds nothing.
 */
export function chatAppAskText(block: MessageBlock): string | undefined {
  if (block.kind !== "ask" || block.status === "answered") return undefined;
  if (!chatAppAnswersAsk(block))
    return [block.text.trim(), CHAT_APP_ASK_NOTE].filter(Boolean).join("\n");
  const options = (block.actions ?? []).map((action, index) => `${index + 1}. ${action.label}`);
  const note = options.length ? CHAT_APP_CHOICE_NOTE : CHAT_APP_REPLY_NOTE;
  return [block.text.trim(), block.detail?.trim(), ...options, note].filter(Boolean).join("\n");
}

/** A list number as people type it, input methods' full-width forms and punctuation included. */
const OPTION_NUMBER = /^[#(（]?\s*(\d{1,3})\s*[.)、。）]?$/;

/**
 * The answer a chat-app reply gives a question it can answer. A reply that is an option's id or
 * label picks it, as in the app's composer, so options that are themselves numbers stay exact;
 * otherwise a number in its list picks that option; anything else is kept as free text.
 */
export function chatAppAskAnswer(block: MessageBlock, reply: string): string | undefined {
  if (block.kind !== "ask" || !chatAppAnswersAsk(block)) return undefined;
  const answer = reply.trim();
  if (!answer) return undefined;
  const chosen = resolveAskChoice(answer, block.actions);
  if (chosen) return chosen.id;
  const number = OPTION_NUMBER.exec(answer.normalize("NFKC"))?.[1];
  return (number && block.actions?.[Number(number) - 1]?.id) || answer;
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
