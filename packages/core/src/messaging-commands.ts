/**
 * Owner text commands, parsed only in the owner's verified 1:1 conversation.
 * Everything that is not an exact command is a normal message to the bot.
 */
export type MessagingCommand = "approve" | "decline" | "leave" | "stop";

export function parseMessagingCommand(text: string): MessagingCommand | null {
  const normalized = text.trim().toUpperCase();
  if (normalized === "YES") return "approve";
  if (normalized === "NO") return "decline";
  if (normalized === "LEAVE") return "leave";
  if (/^STOP(?: NOW)?[.!?…]*$/.test(normalized.replace(/\s+/g, " "))) return "stop";
  // Telegram's /stop command, with the bot's name when sent from a group's command menu.
  if (/^\/STOP(?:@\w+)?$/.test(normalized)) return "stop";
  return null;
}
