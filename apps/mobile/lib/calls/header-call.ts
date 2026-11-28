/**
 * The chat header's Call button. The header is built with the route, before the chat screen and
 * its call controls exist, so the button asks the open chat for that bot to start the call.
 */
const listeners = new Map<string, Set<() => void>>();

export function requestCall(botId: string): void {
  for (const listener of listeners.get(botId) ?? []) listener();
}

/** Starts this bot's call when its header button is pressed; returns the unsubscribe. */
export function onCallRequest(botId: string, listener: () => void): () => void {
  const forBot = listeners.get(botId) ?? new Set();
  forBot.add(listener);
  listeners.set(botId, forBot);
  return () => {
    forBot.delete(listener);
    if (forBot.size === 0) listeners.delete(botId);
  };
}
