import type { NativeScrollEvent } from "react-native";

export type ScrollMetrics = Pick<
  NativeScrollEvent,
  "contentOffset" | "contentSize" | "layoutMeasurement"
>;

const THRESHOLD = 8;

/**
 * iOS `keyboardDismissMode="interactive"` only hides the keyboard when the finger drags into
 * it; a scroll over the messages above it never reaches it, so this flags the first drag
 * toward older messages so the caller can dismiss the keyboard itself.
 *
 * A drag is measured as distance from the oldest message, not as raw offset:
 * `maintainVisibleContentPosition` shifts the offset when a message arrives or grows at the
 * newest end, and that shift must not read as a drag toward older messages.
 */
export class KeyboardScrollBack {
  private dragStart: number | null = null;

  constructor(private readonly list: { inverted: boolean }) {}

  onDragStart(metrics: ScrollMetrics): void {
    this.dragStart = this.distanceFromOldest(metrics);
  }

  onScroll(metrics: ScrollMetrics): boolean {
    if (this.dragStart === null) return false;
    const distance = this.distanceFromOldest(metrics);
    // Measure from the newest point of the drag, so a drag that turns back toward older
    // messages hides the keyboard without first returning to where it started.
    this.dragStart = Math.max(this.dragStart, distance);
    if (this.dragStart - distance <= THRESHOLD) return false;
    this.dragStart = null;
    return true;
  }

  onDragEnd(): void {
    this.dragStart = null;
  }

  private distanceFromOldest({ contentOffset, contentSize, layoutMeasurement }: ScrollMetrics) {
    return this.list.inverted
      ? contentSize.height - layoutMeasurement.height - contentOffset.y
      : contentOffset.y;
  }
}
