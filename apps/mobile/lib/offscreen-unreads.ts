/** How many unread and waiting-on-you chats one inbox row holds; a pinned strip holds several. */
export type InboxSignal = { unread: number; attention: number };

export type RowLayout = { y: number; height: number };

/**
 * First and last rows at least half inside the viewport. When rows are measured but none is
 * on screen (the list header fills it), the range is empty, `last` one before `first`, and
 * sits where the viewport is, so every row counts as above or below it.
 */
export type VisibleRange = { first: number; last: number };

export type JumpDirection = "above" | "below";

/** The pill for one edge: what it counts and the nearest off-screen row it scrolls to. */
export type JumpPill = { kind: "unread" | "attention"; count: number; index: number };

/** Gap between a pill and the edge it sits on, above and below. */
export const PILL_GAP = 8;

/**
 * Rows at least half inside `[top, bottom]` (content coordinates) count as visible.
 * Rows without a measured layout yet are skipped.
 */
export function visibleRange(
  layouts: readonly (RowLayout | undefined)[],
  viewport: { top: number; bottom: number },
): VisibleRange | undefined {
  let first: number | undefined;
  let last: number | undefined;
  // The first measured row that starts below the top edge, for an empty range.
  let after: number | undefined;
  for (let index = 0; index < layouts.length; index += 1) {
    const layout = layouts[index];
    if (!layout) continue;
    if (layout.y >= viewport.top) after ??= index;
    if (layout.y >= viewport.bottom) break;
    const shown =
      Math.min(layout.y + layout.height, viewport.bottom) - Math.max(layout.y, viewport.top);
    if (shown < layout.height / 2) continue;
    first ??= index;
    last = index;
  }
  if (first !== undefined && last !== undefined) return { first, last };
  if (!layouts.some(Boolean)) return undefined;
  const edge = after ?? layouts.length;
  return { first: edge, last: edge - 1 };
}

/**
 * Unread chats above and below the visible rows. A chat waiting on you outranks unread ones:
 * if any off-screen chat in that direction needs attention, that edge's pill counts those.
 */
export function offscreenUnreads(
  signals: readonly InboxSignal[],
  range: VisibleRange,
): { above?: JumpPill; below?: JumpPill } {
  const above = { unread: 0, attention: 0, nearest: -1, nearestAttention: -1 };
  const below = { unread: 0, attention: 0, nearest: -1, nearestAttention: -1 };
  signals.forEach((signal, index) => {
    if (index >= range.first && index <= range.last) return;
    if (signal.unread === 0 && signal.attention === 0) return;
    const edge = index < range.first ? above : below;
    edge.unread += signal.unread;
    edge.attention += signal.attention;
    // Nearest to the visible rows: the last match above, the first match below.
    if (index < range.first || edge.nearest === -1) edge.nearest = index;
    if (signal.attention > 0 && (index < range.first || edge.nearestAttention === -1)) {
      edge.nearestAttention = index;
    }
  });
  return { above: pill(above), below: pill(below) };
}

function pill(edge: {
  unread: number;
  attention: number;
  nearest: number;
  nearestAttention: number;
}): JumpPill | undefined {
  if (edge.nearest === -1) return undefined;
  if (edge.nearestAttention !== -1) {
    return { kind: "attention", count: edge.attention, index: edge.nearestAttention };
  }
  return { kind: "unread", count: edge.unread, index: edge.nearest };
}

/**
 * The scroll offset that brings `layout` just into view from `direction`: a row above lands
 * at the bottom, above the lower pill's space; a row below lands at the top, under the upper
 * pill's space (the last row lands flush at the bottom).
 */
export function jumpOffset(
  direction: JumpDirection,
  layout: RowLayout,
  metrics: {
    viewportHeight: number;
    contentHeight: number;
    topInset: number;
    bottomInset: number;
    pillSpace: number;
    isLast: boolean;
  },
): number {
  const { viewportHeight, contentHeight, topInset, bottomInset, pillSpace } = metrics;
  const offset =
    direction === "below" && !metrics.isLast
      ? layout.y - topInset - pillSpace
      : layout.y +
        layout.height -
        viewportHeight +
        bottomInset +
        (direction === "above" ? pillSpace : 0);
  const max = Math.max(-topInset, contentHeight - viewportHeight + bottomInset);
  return Math.min(Math.max(offset, -topInset), max);
}

/** Where an unmeasured row probably is: rows so far average their measured height. */
export function estimateRowLayout(measured: readonly RowLayout[], index: number): RowLayout {
  const height =
    measured.length > 0
      ? measured.reduce((total, row) => total + row.height, 0) / measured.length
      : 72;
  return { y: height * index, height };
}
