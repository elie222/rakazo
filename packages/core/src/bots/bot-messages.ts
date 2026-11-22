import type { BotMessageIntent, MessageBlock } from "@rakazo/contracts";
import { truncatePlainText } from "../messages/markdown-plain.js";

export const BOT_MESSAGE_MAX_LENGTH = 8_000;

/** Bots that hit the limit tend to resend the text in chunks; the error steers them to files. */
export const BOT_MESSAGE_TOO_LONG = `message exceeds the ${BOT_MESSAGE_MAX_LENGTH} character limit. Nothing was sent. Save long content to a file and send it with files instead of splitting it across messages.`;

/**
 * How many bot-started deliveries may chain before the next one is refused. Messaging is
 * fire-and-forget, so without it two bots could reply to each other forever. It is set far above
 * any real handoff so it only stops a runaway loop. A person's own message always starts a
 * fresh chain at hop 0.
 */
export const BOT_MESSAGE_MAX_HOPS = 100;

/** Cap total description characters across the rendered teammate directory. */
export const BOT_DIRECTORY_DESCRIPTIONS_MAX_LENGTH = 8_000;

export interface BotAddress {
  id: string;
  name: string;
  description?: string;
}

export function clampBotMessage(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= BOT_MESSAGE_MAX_LENGTH
    ? trimmed
    : `${truncatePlainText(trimmed, BOT_MESSAGE_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * The hop a delivery gets when the sender was itself woken at `sourceHop`: how deep the
 * bot-started chain is. A person's own message starts a fresh chain at hop 0.
 */
export function nextBotMessageHop(sourceHop: number | undefined): number {
  return Number.isInteger(sourceHop) && (sourceHop as number) > 0 ? (sourceHop as number) + 1 : 1;
}

export function botMessageHopExhausted(hop: number): boolean {
  return hop > BOT_MESSAGE_MAX_HOPS;
}

export type BotMessageContext = Extract<MessageBlock, { kind: "bot_message_received" }>;

export function botMessageContext(blocks: readonly MessageBlock[]): BotMessageContext | undefined {
  return blocks.find((block): block is BotMessageContext => block.kind === "bot_message_received");
}

export function botMessageAllowsSilence(
  intent: BotMessageIntent | undefined,
  repliesToRequest = false,
): boolean {
  return intent === "fyi" && !repliesToRequest;
}

/** Resolve by id first, then an unambiguous exact name, then case-insensitively. */
export function resolveBotAddress<T extends BotAddress>(
  bots: readonly T[],
  input: { botId?: string; name?: string },
): T | undefined {
  const botId = input.botId?.trim();
  if (botId) return bots.find((bot) => bot.id === botId);
  const name = input.name?.trim();
  if (!name) return undefined;
  const exact = bots.filter((bot) => bot.name === name);
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
  const lower = name.toLowerCase();
  const matches = bots.filter((bot) => bot.name.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}
