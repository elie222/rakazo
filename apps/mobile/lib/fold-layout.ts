import type { FoldRegion } from "./fold-regions";

/** Shortest region above or below a tabletop fold worth laying content into. */
const TABLETOP_MIN_HEIGHT = 160;

/** A division frame that is well formed and crosses the window. */
export function crossesWindow(region: FoldRegion, width: number, height: number): boolean {
  return (
    [region.x, region.y, region.width, region.height].every(Number.isFinite) &&
    region.width >= 0 &&
    region.height >= 0 &&
    region.x < width &&
    region.x + region.width > 0 &&
    region.y < height &&
    region.y + region.height > 0
  );
}

/**
 * Propped open like a laptop: what stays above a horizontal fold, and the hinge below it.
 * Null when the window is flat, folded like a book, or a half is too short to use.
 */
export function tabletopLayout(
  width: number,
  height: number,
  regions: FoldRegion[],
): { top: number; gap: number } | null {
  const fold = regions.find(
    (region) =>
      crossesWindow(region, width, height) &&
      region.width > region.height &&
      region.y >= TABLETOP_MIN_HEIGHT &&
      height - region.y - region.height >= TABLETOP_MIN_HEIGHT,
  );
  return fold ? { top: fold.y, gap: fold.height } : null;
}
