import { useSyncExternalStore } from "react";
import { useWindowDimensions } from "react-native";

/** Narrowest window that keeps the chat list beside the open chat: an unfolded foldable or a tablet. */
const SPLIT_MIN_WIDTH = 700;
const INBOX_MIN_WIDTH = 300;
const INBOX_MAX_WIDTH = 380;

let inboxHidden = false;
const listeners = new Set<() => void>();

export function splitsWindow(windowWidth: number): boolean {
  return windowWidth >= SPLIT_MIN_WIDTH;
}

export function inboxPaneWidth(windowWidth: number): number {
  return Math.round(Math.min(INBOX_MAX_WIDTH, Math.max(INBOX_MIN_WIDTH, windowWidth / 3)));
}

/** Hides the chat list so the open chat fills a wide window, or brings it back. */
export function setInboxHidden(hidden: boolean) {
  if (inboxHidden === hidden) return;
  inboxHidden = hidden;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const isInboxHidden = () => inboxHidden;

/**
 * split: the window is wide enough for the chat list and a chat side by side.
 * contentWidth: what is left for the screen beside the list.
 */
export function useSplitView() {
  const { width } = useWindowDimensions();
  const hidden = useSyncExternalStore(subscribe, isInboxHidden, isInboxHidden);
  const split = splitsWindow(width);
  const inboxWidth = inboxPaneWidth(width);
  const showsInbox = split && !hidden;
  return {
    split,
    inboxHidden: hidden,
    inboxWidth,
    contentWidth: showsInbox ? width - inboxWidth : width,
  };
}
