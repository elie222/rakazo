const listeners = new Map<string, Set<(text: string) => void>>();

/** Text a card in a chat hands to that chat's composer; the person still sends it. */
export function offerComposerText(threadKey: string, text: string): void {
  for (const listener of listeners.get(threadKey) ?? []) listener(text);
}

export function subscribeComposerOffer(
  threadKey: string,
  listener: (text: string) => void,
): () => void {
  let set = listeners.get(threadKey);
  if (!set) {
    set = new Set();
    listeners.set(threadKey, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(threadKey);
  };
}
