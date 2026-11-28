/**
 * The chat header's Call button. The header is built with the route, before the chat screen and
 * its call controls exist, so the button asks the open chat for that bot to start the call.
 */
const listeners = new Map<string, Array<() => void>>();
/** A tap that arrived before its chat could take it, waiting this long for the chat to mount. */
const PENDING_MS = 10_000;
const pending = new Map<string, number>();
const showListeners = new Set<() => void>();

/**
 * Starts this bot's call from the newest chat screen for it, so a chat pushed over another chat
 * of the same bot does not ring twice. A tap before any chat listens waits for the first one.
 */
export function requestCall(botId: string, now = Date.now()): void {
  const latest = listeners.get(botId)?.at(-1);
  if (latest) {
    pending.delete(botId);
    latest();
    return;
  }
  pending.set(botId, now);
}

/** Starts this bot's call when its header button is pressed; returns the unsubscribe. */
export function onCallRequest(botId: string, listener: () => void, now = Date.now()): () => void {
  const forBot = listeners.get(botId) ?? [];
  forBot.push(listener);
  listeners.set(botId, forBot);
  const askedAt = pending.get(botId);
  if (askedAt !== undefined) {
    pending.delete(botId);
    if (now - askedAt <= PENDING_MS) queueMicrotask(listener);
  }
  return () => {
    const index = forBot.indexOf(listener);
    if (index >= 0) forBot.splice(index, 1);
    if (forBot.length === 0 && listeners.get(botId) === forBot) listeners.delete(botId);
  };
}

/** Brings a minimized call back to full screen, as Call does while a call is already on. */
export function showCall(): void {
  for (const listener of showListeners) listener();
}

export function onShowCall(listener: () => void): () => void {
  showListeners.add(listener);
  return () => {
    showListeners.delete(listener);
  };
}
