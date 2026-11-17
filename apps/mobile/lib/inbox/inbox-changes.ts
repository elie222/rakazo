import type { Href } from "expo-router";

const listeners = new Set<() => void>();
const openers = new Set<(href: Href) => void>();

/** A screen outside the inbox created a chat; the inbox reloads instead of waiting for its poll. */
export function notifyInboxChanged() {
  for (const listener of listeners) listener();
}

export function onInboxChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Opens a chat the way the inbox does, so the side-by-side layout replaces the open chat
 * instead of stacking on it. False when no inbox is mounted to do it.
 */
export function openChatFromInbox(href: Href): boolean {
  const opener = [...openers].at(-1);
  if (!opener) return false;
  opener(href);
  return true;
}

export function onOpenChatFromInbox(opener: (href: Href) => void): () => void {
  openers.add(opener);
  return () => openers.delete(opener);
}
