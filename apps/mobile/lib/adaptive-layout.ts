/** Material's compact window bound in dp: a phone held upright, or a foldable's cover screen. */
const COMPACT_WINDOW = 600;
/** Widest the thread and inbox columns grow on an unfolded foldable or a tablet. */
export const READABLE_COLUMN_WIDTH = 720;

type WindowSize = { width: number; height: number };

/** The shorter side decides, so an unfolded screen stays expanded in either orientation. */
export function isCompactWindow(window: WindowSize): boolean {
  return Math.min(window.width, window.height) < COMPACT_WINDOW;
}

/**
 * Side space that centres a readable column in a wide window. Zero on a phone, unless a
 * display cutout or system bar needs more than the column leaves.
 */
export function readableGutter(windowWidth: number, edgeInset = 0): number {
  return Math.max(0, edgeInset, (windowWidth - READABLE_COLUMN_WIDTH) / 2);
}
