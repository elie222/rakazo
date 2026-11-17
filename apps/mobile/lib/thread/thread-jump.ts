/**
 * Keeps a search hit scrolled to its message.
 *
 * The pinned page starts at the older rows above the match. The first layout
 * pass often reports y=0, and paging (#1214) then changes the content size,
 * which puts the scroll back on those older rows. Hold the measured offset and
 * reapply it until the reader drags.
 */
export class ThreadJumpAnchor {
  private targetId: string | null = null;
  private layoutY: number | null = null;
  private clearance = 0;

  begin(messageId: string | null): void {
    this.targetId = messageId;
    this.layoutY = null;
    this.clearance = 0;
  }

  release(): void {
    this.begin(null);
  }

  holds(): boolean {
    return this.targetId != null;
  }

  onMessageLayout(
    messageId: string,
    layoutY: number,
    index: number,
    headerClearance: number,
  ): number | null {
    if (this.targetId !== messageId) return null;
    // A later row at y=0 has not been stacked yet; scrolling there shows an older reply.
    if (layoutY <= 0 && index > 0) return this.align(headerClearance);
    this.layoutY = layoutY;
    return this.align(headerClearance);
  }

  /**
   * Hold paging only while the matched row will be drawn and has no offset yet.
   * A hit that never renders (a dismissed card, for example) must not block
   * newer pages.
   */
  blocksPaging(targetDrawn: boolean, headerClearance: number): boolean {
    return this.holds() && this.align(headerClearance) == null && targetDrawn;
  }

  /** Offset for the current measurement, using the latest header clearance. */
  align(headerClearance: number): number | null {
    if (this.targetId == null || this.layoutY == null) return null;
    this.clearance = headerClearance;
    return Math.max(0, this.layoutY - this.clearance);
  }
}
