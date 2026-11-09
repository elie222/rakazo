/**
 * Owner text commands, parsed only in the owner's verified 1:1 conversation.
 * Everything that is not an exact command is a normal message to the bot.
 */
export type MessagingCommand = "approve" | "decline" | "leave" | "stop";

/** "Stop" in each app language, so people can stop work in their own words. */
const STOP_WORDS = new Set([
  "STOP",
  "STOP NOW",
  // German
  "STOPP",
  "STOPP JETZT",
  // Spanish
  "PARA",
  "DETENTE",
  // Dutch
  "STOP NU",
  // Polish
  "ZATRZYMAJ",
  "PRZESTAŃ",
  // Russian
  "СТОП",
  "ОСТАНОВИСЬ",
  // Japanese
  "停止",
  "ストップ",
  "止めて",
  // Chinese
  "停下",
]);

export function parseMessagingCommand(text: string): MessagingCommand | null {
  const normalized = text.trim().toUpperCase();
  if (normalized === "YES") return "approve";
  if (normalized === "NO") return "decline";
  if (normalized === "LEAVE") return "leave";
  const bare = normalized.replace(/\s+/g, " ").replace(/[.!?…。！？]+$/u, "");
  if (STOP_WORDS.has(bare)) return "stop";
  return null;
}
