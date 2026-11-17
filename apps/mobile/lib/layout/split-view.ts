import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { useWindowDimensions } from "react-native";
import { crossesWindow } from "./fold-layout";
import type { FoldRegion } from "./fold-regions";
import { useFoldRegions } from "./fold-regions";

/** Narrowest window that keeps the chat list beside the open chat: an unfolded foldable or a tablet. */
const SPLIT_MIN_WIDTH = 600;
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

/** A space heading must not leave a pane making requests in another space. */
export function closesSplitPane(
  pathname: string,
  paneSpaceId: string | null,
  selectedSpaceId: string,
): boolean {
  return pathname !== "/" && paneSpaceId !== selectedSpaceId;
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
 * inboxShown: the list is beside the screen; a book-like fold keeps it there so no column
 * straddles the hinge.
 * contentWidth: what is left for the screen beside the list.
 */
export function useSplitView() {
  const { width, height } = useWindowDimensions();
  const folds = useFoldRegions();
  const { hidden, chosenWidth } = useSyncExternalStore(subscribe, currentState, currentState);
  const split = splitsWindow(width);
  const { inboxWidth, gap, folded } = splitPaneLayout(width, height, chosenWidth, folds);
  const inboxShown = split && (!hidden || folded);
  return {
    split,
    inboxHidden: hidden,
    inboxShown,
    inboxWidth,
    foldGap: gap,
    foldActive: folded,
    windowWidth: width,
    contentWidth: inboxShown ? width - inboxWidth - gap : width,
  };
}

/** A vertical division already includes its safety margins in window coordinates. */
export function splitPaneLayout(
  width: number,
  height: number,
  chosenWidth: number | null,
  regions: FoldRegion[],
): { inboxWidth: number; gap: number; folded: boolean } {
  const fold = regions.find(
    (region) =>
      crossesWindow(region, width, height) &&
      region.height > region.width &&
      region.x >= INBOX_MIN_WIDTH &&
      width - region.x - region.width >= CONTENT_MIN_WIDTH,
  );
  return splitsWindow(width) && fold
    ? { inboxWidth: fold.x, gap: fold.width, folded: true }
    : { inboxWidth: inboxPaneWidth(width, chosenWidth), gap: 0, folded: false };
}
