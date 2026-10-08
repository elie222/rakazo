/** From the largest standard text size up, side-by-side settings content stacks vertically. */
export function stacksAtTextScale(fontScale: number): boolean {
  return fontScale >= 1.35;
}
