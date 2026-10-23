/** A chat's own settings: the group's in a group chat, the bot's in a one-to-one chat. */
export type ChatSettingsRoute =
  | { pathname: "/group-settings"; params: { groupId: string } }
  | { pathname: "/bot-settings"; params: { botId: string } };

export function chatSettingsRoute(chat: {
  groupId?: string | null;
  botId?: string | null;
  /** A chat opened read-only (an archived one) has no settings to open. */
  readOnly?: boolean;
}): ChatSettingsRoute | null {
  if (chat.readOnly) return null;
  if (chat.groupId) return { pathname: "/group-settings", params: { groupId: chat.groupId } };
  if (chat.botId) return { pathname: "/bot-settings", params: { botId: chat.botId } };
  return null;
}
