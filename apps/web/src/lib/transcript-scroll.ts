export function transcriptIsNearEnd(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

export function transcriptCanSnapAfterFrame(
  element: Pick<HTMLElement, "scrollTop">,
  queuedScrollTop: number,
): boolean {
  return element.scrollTop === queuedScrollTop;
}

export function transcriptMovedDown(previousScrollTop: number | null, scrollTop: number): boolean {
  return previousScrollTop !== null && scrollTop >= previousScrollTop;
}
