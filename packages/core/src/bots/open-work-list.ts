/** Open-work items a bot's settings show before Show more. */
export const OPEN_WORK_PREVIEW_COUNT = 5;

/**
 * The open-work items a bot's settings list: the first few still open, then with Show more
 * every open item followed by the parked ones.
 */
export function shownOpenWork<T extends { status: string }>(
  items: readonly T[],
  all: boolean,
): T[] {
  const open = items.filter((item) => item.status !== "parked");
  return all
    ? [...open, ...items.filter((item) => item.status === "parked")]
    : open.slice(0, OPEN_WORK_PREVIEW_COUNT);
}
