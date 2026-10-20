import { currentApiBase } from "./api";
import type { InboxSpace } from "./inbox-spaces";
import { currentSessionGeneration, subscribeSessionGeneration } from "./session";

const empty: readonly InboxSpace[] = [];
let snapshot = empty;
let generation = -1;
let apiBase = "";
const listeners = new Set<() => void>();

// Share the home roster without another request or navigation payload.
export function setSearchInbox(spaces: readonly InboxSpace[]): void {
  snapshot = spaces;
  generation = currentSessionGeneration();
  apiBase = currentApiBase();
  for (const listener of listeners) listener();
}

export function getSearchInbox(): readonly InboxSpace[] {
  return generation === currentSessionGeneration() && apiBase === currentApiBase()
    ? snapshot
    : empty;
}

export function subscribeSearchInbox(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribe = subscribeSessionGeneration(listener);
  return () => {
    listeners.delete(listener);
    unsubscribe();
  };
}
