/**
 * Owner text commands, parsed only in the owner's verified 1:1 conversation.
 * Everything that is not an exact command is a normal message to the bot.
 */
export type PhoneCommand = "approve" | "decline" | "leave";

export function parsePhoneCommand(text: string): PhoneCommand | null {
  const normalized = text.trim().toUpperCase();
  if (normalized === "YES") return "approve";
  if (normalized === "NO") return "decline";
  if (normalized === "LEAVE") return "leave";
  return null;
}
