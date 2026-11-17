/** Widest the thread and inbox columns grow on an unfolded foldable or a tablet. */
export const READABLE_COLUMN_WIDTH = 720;

/** Widest a standalone form, such as sign-in or plans, grows on a tablet. */
export const FORM_COLUMN_WIDTH = 480;

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
