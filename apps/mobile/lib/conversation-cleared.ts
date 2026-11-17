const listeners = new Set<(botId: string) => void>();

/** Runs when a bot's conversation is cleared, wherever it was cleared from. */
export function onConversationCleared(listener: (botId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyConversationCleared(botId: string) {
  for (const listener of listeners) listener(botId);
}
