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

/** What a chat's title opens: the bot's profile in a one-to-one chat, or the group's settings. */
export type ChatTitleRoute =
  | Extract<ChatSettingsRoute, { pathname: "/group-settings" }>
  | { pathname: "/bot-profile"; params: { botId: string; name: string } };

export function chatTitleRoute(chat: {
  groupId?: string | null;
  botId?: string | null;
  /** The bot's name, so its profile names it before the bot loads. */
  name?: string;
  /** An archived chat's title opens nothing until the chat is restored. */
  readOnly?: boolean;
}): ChatTitleRoute | null {
  if (chat.readOnly) return null;
  if (chat.groupId) return { pathname: "/group-settings", params: { groupId: chat.groupId } };
  if (chat.botId) {
    return { pathname: "/bot-profile", params: { botId: chat.botId, name: chat.name ?? "" } };
  }
  return null;
}
