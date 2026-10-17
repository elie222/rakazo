import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { useWindowDimensions } from "react-native";

/** Narrowest window that keeps the chat list beside the open chat: an unfolded foldable or a tablet. */
const SPLIT_MIN_WIDTH = 700;
const INBOX_MIN_WIDTH = 240;
const CONTENT_MIN_WIDTH = 360;
const INBOX_WIDTH_KEY = "rakazo.inbox-width";

type SplitState = { hidden: boolean; chosenWidth: number | null };
let state: SplitState = { hidden: false, chosenWidth: null };
const listeners = new Set<() => void>();

function update(next: Partial<SplitState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function splitsWindow(windowWidth: number): boolean {
  return windowWidth >= SPLIT_MIN_WIDTH;
}

/** The list keeps the width it was dragged to, within what leaves the chat readable. */
export function inboxPaneWidth(windowWidth: number, chosenWidth: number | null = null): number {
  const preferred = chosenWidth ?? Math.min(380, Math.max(300, windowWidth / 3));
  const widest = Math.max(INBOX_MIN_WIDTH, windowWidth - CONTENT_MIN_WIDTH);
  return Math.round(Math.min(widest, Math.max(INBOX_MIN_WIDTH, preferred)));
}

/** Hides the chat list so the open chat fills a wide window, or brings it back. */
export function setInboxHidden(hidden: boolean) {
  if (state.hidden !== hidden) update({ hidden });
}

export function chooseInboxWidth(width: number) {
  const chosenWidth = Math.round(width);
  update({ chosenWidth });
  void SecureStore.setItemAsync(INBOX_WIDTH_KEY, String(chosenWidth)).catch(() => undefined);
}

export async function loadInboxWidth() {
  try {
    const stored = Number(await SecureStore.getItemAsync(INBOX_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0 && state.chosenWidth === null) {
      update({ chosenWidth: stored });
    }
  } catch {
    // Keep the default width when SecureStore is unavailable.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const currentState = () => state;

/**
 * split: the window is wide enough for the chat list and a chat side by side.
 * contentWidth: what is left for the screen beside the list.
 */
export function useSplitView() {
  const { width } = useWindowDimensions();
  const { hidden, chosenWidth } = useSyncExternalStore(subscribe, currentState, currentState);
  const split = splitsWindow(width);
  const inboxWidth = inboxPaneWidth(width, chosenWidth);
  const showsInbox = split && !hidden;
  return {
    split,
    inboxHidden: hidden,
    inboxWidth,
    windowWidth: width,
    contentWidth: showsInbox ? width - inboxWidth : width,
  };
}
