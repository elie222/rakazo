/** Compact screen bound in dp: a phone held upright, or a foldable's cover screen. */
const COMPACT_SCREEN = 600;
/** Widest the thread and inbox columns grow on an unfolded foldable or a tablet. */
export const READABLE_COLUMN_WIDTH = 720;

type ScreenSize = { width: number; height: number };

/** The short side keeps phone classification stable across rotation. */
export function isCompactScreen(screen: ScreenSize): boolean {
  return Math.min(screen.width, screen.height) < COMPACT_SCREEN;
}

/**
 * Side space that centres a readable column in a wide window. Zero on a phone, unless a
 * display cutout or system bar needs more than the column leaves.
 */
export function readableGutter(windowWidth: number, edgeInset = 0): number {
  return Math.max(0, edgeInset, (windowWidth - READABLE_COLUMN_WIDTH) / 2);
}

/** Centre in the usable area while preserving each physical safe edge independently. */
export function readableGutters(windowWidth: number, insets: { left: number; right: number }) {
  const extra = readableGutter(windowWidth - insets.left - insets.right);
  return { left: insets.left + extra, right: insets.right + extra };
}
