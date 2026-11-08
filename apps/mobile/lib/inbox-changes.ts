const listeners = new Set<() => void>();

/** A screen outside the inbox created a chat; the inbox reloads instead of waiting for its poll. */
export function notifyInboxChanged() {
  for (const listener of listeners) listener();
}

export function onInboxChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
