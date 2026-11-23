import type { ThreadMessage } from "@rakazo/contracts";
import type { ThreadScrollState } from "@rakazo/core";

export type { ThreadScrollState } from "@rakazo/core";

export type ThreadScrollAction = "jump" | "smooth" | null;

/** The last row that isn't a folded peer reply, so expanding or collapsing a fold isn't an arrival. */
export function latestArrivalMessage<M extends { id: string }>(
  visible: readonly M[],
  markerOf: ReadonlyMap<string, string>,
): M | undefined {
  return visible.findLast((message) => !markerOf.has(message.id));
}

/** Older transcripts do not carry a human author; retain their bubble ownership rule. */
export function isOwnThreadMessage(
  message: (Pick<ThreadMessage, "role" | "blocks"> & { userId?: string }) | undefined,
  userId: string,
): boolean {
  if (message?.role !== "user") return false;
  if (message.userId !== undefined) return message.userId === userId;
  return !message.blocks.some(
    (block) => block.kind === "channel_message" || block.kind === "bot_message_received",
  );
}

export type ThreadRowKey = {
  messageId: string | null;
  unsentKeys: readonly string[];
  own: boolean;
};

export function latestThreadRowKey(
  messageId: string | null,
  unsentKeys: readonly string[] = [],
  own = false,
): ThreadRowKey {
  return { messageId, unsentKeys, own };
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
  private latestRowKey: ThreadRowKey | null = null;
  private followingOwnSend: ThreadScrollAction = null;
  private currentState: ThreadScrollState = { detached: false, unread: false };

  openThread(threadKey: string): void {
    if (this.threadKey === threadKey) return;
    this.threadKey = threadKey;
    this.laidOut = false;
    this.contentReady = false;
    this.latestRowKey = null;
    this.followingOwnSend = null;
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

  onOwnSend(): ThreadScrollAction {
    this.followingOwnSend = this.currentState.detached ? "jump" : "smooth";
    this.dragging = false;
    this.userScrolling = false;
    this.pendingFollow = false;
    this.jumpToLatest();
    return this.followingOwnSend;
  }

  onContentChanged(blocked: boolean, next: ThreadRowKey): ThreadScrollAction {
    if (blocked) return null;
    this.contentReady = true;
    const previous = this.latestRowKey;
    this.latestRowKey = next;
    const messageChanged = next.messageId !== (previous?.messageId ?? null);
    const outboxAdded = next.unsentKeys.some((key) => !previous?.unsentKeys.includes(key));
    const ownSendAction = this.followingOwnSend;
    const outboxRemoved = previous?.unsentKeys.some((key) => !next.unsentKeys.includes(key));
    if ((messageChanged && next.own) || outboxRemoved) this.followingOwnSend = null;
    if (!messageChanged && !outboxAdded) return null;
    const initial =
      previous === null || (previous.messageId === null && previous.unsentKeys.length === 0);
    const own = !messageChanged || next.own;
    if (own) {
      if (ownSendAction) return ownSendAction;
      if (this.currentState.detached || this.userScrolling) return null;
      return initial ? (this.laidOut ? "jump" : null) : "smooth";
    }
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
    this.followingOwnSend = null;
    this.dragging = true;
    this.userScrolling = true;
  }

  onUserDragEnd(): void {
    this.dragging = false;
  }

  onUserMomentumEnd(): ThreadScrollAction {
    if (this.dragging) return null;
    this.userScrolling = false;
    if (this.followingOwnSend) return this.followingOwnSend;
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
    if (this.followingOwnSend) return this.state();
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
