export function transcriptIsNearEnd(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

export function transcriptCanSnapAfterFrame(
  element: Pick<HTMLElement, "scrollTop"> | null,
  queuedElement: Pick<HTMLElement, "scrollTop">,
  queuedScrollTop: number,
): boolean {
  return element === queuedElement && queuedElement.scrollTop === queuedScrollTop;
}

export function stillStickAfterRefresh(
  stickToEnd: boolean,
  previous: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight"> | null | undefined,
  current: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight"> | null | undefined,
): boolean {
  if (!stickToEnd) return false;
  // missing scroller -> keep stick (same as inline !scrollElement / !element)
  if (!previous || !current) return true;
  // Remount-safe (#4007 / bot-switch): after threads.get the transcript node can
  // remount scrolled up while the pre-refresh scroller was still near the end.
  // Either near-end reading is enough to keep stick.
  return transcriptIsNearEnd(previous) || transcriptIsNearEnd(current);
}

/** Tail snap after layout; reads the live scroller so a remounted transcript still sticks. */
export function scheduleTranscriptSnapToEnd(
  readScroller: () => Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight"> | null,
  stickToEnd: boolean,
): void {
  if (!stickToEnd) return;
  const queuedElement = readScroller();
  const queuedScrollTop = queuedElement?.scrollTop ?? 0;
  const snap = () => {
    const element = readScroller();
    if (!element) return;
    const sameUnmoved =
      queuedElement != null && transcriptCanSnapAfterFrame(element, queuedElement, queuedScrollTop);
    const replacedAndNearEnd =
      queuedElement != null && element !== queuedElement && transcriptIsNearEnd(element);
    const firstMount = queuedElement == null && transcriptIsNearEnd(element);
    if (sameUnmoved || replacedAndNearEnd || firstMount) {
      element.scrollTop = element.scrollHeight;
    }
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(snap));
}

export function transcriptMovedDown(previousScrollTop: number | null, scrollTop: number): boolean {
  return previousScrollTop !== null && scrollTop >= previousScrollTop;
}

/**
 * The first message row at or below the scroll position: the anchor a prepend
 * must hold steady. Content appended at the bottom moves no row, so anchoring
 * on the row keeps the adjustment free of that growth.
 */
export function firstVisibleTranscriptRow(
  element: Pick<HTMLElement, "querySelectorAll" | "scrollTop"> | null,
): HTMLElement | null {
  if (!element) return null;
  for (const row of element.querySelectorAll<HTMLElement>("[data-message-id]")) {
    if (row.offsetTop + row.offsetHeight > element.scrollTop) return row;
  }
  return null;
}
