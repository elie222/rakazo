import type { ThreadScrollState } from "@rakazo/core";

export type { ThreadScrollState } from "@rakazo/core";

export type ThreadScrollAction = "jump" | "smooth" | null;

/** The last row that isn't a folded peer reply, so expanding or collapsing a fold isn't an arrival. */
export function latestArrivalMessageId<M extends { id: string }>(
  visible: readonly M[],
  markerOf: ReadonlyMap<string, string>,
): string | null {
  return visible.findLast((message) => !markerOf.has(message.id))?.id ?? null;
}

export class ThreadScrollBehavior {
  private threadKey: string | null = null;
  private laidOut = false;
  private contentReady = false;
  private viewportHeight: number | null = null;
  private contentHeight: number | null = null;
  private distanceFromEnd = 0;
  private dragging = false;
  private userScrolling = false;
  private pendingFollow = false;
  private latestMessageId: string | null = null;
  private currentState: ThreadScrollState = { detached: false, unread: false };

  openThread(threadKey: string): void {
    if (this.threadKey === threadKey) return;
    this.threadKey = threadKey;
    this.laidOut = false;
    this.contentReady = false;
    this.latestMessageId = null;
    this.viewportHeight = null;
    this.contentHeight = null;
    this.distanceFromEnd = 0;
    this.dragging = false;
    this.userScrolling = false;
    this.pendingFollow = false;
    this.currentState = { detached: false, unread: false };
  }

  onLayout(viewportHeight?: number): ThreadScrollAction {
    this.laidOut = true;
    if (viewportHeight !== undefined) {
      this.viewportHeight = viewportHeight;
      this.onUserScroll(this.distanceFromEnd);
    }
    if (this.userScrolling) return null;
    return this.contentReady && !this.currentState.detached ? "jump" : null;
  }

  onContentChanged(blocked: boolean, latestMessageId: string | null): ThreadScrollAction {
    if (blocked) return null;
    this.contentReady = true;
    if (latestMessageId === null || latestMessageId === this.latestMessageId) return null;
    const initial = this.latestMessageId === null;
    this.latestMessageId = latestMessageId;
    if (this.userScrolling) {
      this.pendingFollow = true;
      if (this.currentState.detached) this.currentState = { detached: true, unread: true };
      return null;
    }
    if (initial) return this.laidOut ? "jump" : null;
    if (this.currentState.detached) {
      this.currentState = { detached: true, unread: true };
      return null;
    }
    return "smooth";
  }

  onUserDragStart(): void {
    this.dragging = true;
    this.userScrolling = true;
  }

  onUserDragEnd(): void {
    this.dragging = false;
  }

  onUserMomentumEnd(): ThreadScrollAction {
    if (this.dragging) return null;
    this.userScrolling = false;
    const follow = this.pendingFollow && !this.currentState.detached;
    this.pendingFollow = false;
    return follow ? this.jumpToLatest() : null;
  }

  onProgrammaticScroll(): void {
    this.pendingFollow = false;
    this.userScrolling = this.dragging;
  }

  isTrackingUserScroll(): boolean {
    return this.userScrolling;
  }

  onContentSizeChanged(height: number): ThreadScrollState {
    this.contentHeight = height;
    return this.onUserScroll(this.distanceFromEnd);
  }

  onUserScroll(distanceFromEnd: number): ThreadScrollState {
    const maxDistance =
      this.contentHeight === null || this.viewportHeight === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, this.contentHeight - this.viewportHeight);
    this.distanceFromEnd = Math.min(maxDistance, Math.max(0, distanceFromEnd));
    const detached = this.distanceFromEnd > 80;
    this.currentState = {
      detached,
      unread: detached ? this.currentState.unread || this.pendingFollow : false,
    };
    return this.state();
  }

  jumpToLatest(): ThreadScrollAction {
    this.distanceFromEnd = 0;
    this.currentState = { detached: false, unread: false };
    return "smooth";
  }

  state(): ThreadScrollState {
    return { ...this.currentState };
  }
}
