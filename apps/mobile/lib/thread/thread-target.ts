/** The conversation a chat screen shows: a bot's chat, a group, or a topic in a bot's chat. */
export type ChatTarget = { botId?: string; groupId?: string; topicId?: string };

/** What every thread RPC takes to name that conversation. */
export function chatTargetInput({ botId, groupId, topicId }: ChatTarget) {
  if (groupId) return { groupId };
  return topicId ? { botId: botId!, topicId } : { botId: botId! };
}

/** One key per conversation, for state that must stay with it: read visits, sends, attachments. */
export function chatTargetKey({ botId, groupId, topicId }: ChatTarget): string | undefined {
  return groupId ?? topicId ?? botId;
}
