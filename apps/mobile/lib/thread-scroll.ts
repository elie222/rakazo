export type ThreadScrollAction = "jump" | "smooth" | null;

export type ThreadScrollState = {
  detached: boolean;
  unread: boolean;
};

export class ThreadScrollBehavior {
  private threadKey: string | null = null;
  private laidOut = false;
  private contentReady = false;
  private latestMessageId: string | null = null;
  private currentState: ThreadScrollState = { detached: false, unread: false };

  openThread(threadKey: string): void {
    if (this.threadKey === threadKey) return;
    this.threadKey = threadKey;
    this.laidOut = false;
    this.contentReady = false;
    this.latestMessageId = null;
    this.currentState = { detached: false, unread: false };
  }

  onLayout(): ThreadScrollAction {
    this.laidOut = true;
    return this.contentReady && !this.currentState.detached ? "jump" : null;
  }

  onContentChanged(blocked: boolean, latestMessageId: string | null): ThreadScrollAction {
    if (blocked) return null;
    this.contentReady = true;
    if (latestMessageId === null || latestMessageId === this.latestMessageId) return null;
    const initial = this.latestMessageId === null;
    this.latestMessageId = latestMessageId;
    if (initial) return this.laidOut ? "jump" : null;
    if (this.currentState.detached) {
      this.currentState = { detached: true, unread: true };
      return null;
    }
    return "smooth";
  }

  onUserScroll(distanceFromEnd: number): ThreadScrollState {
    const detached = distanceFromEnd > 80;
    this.currentState = {
      detached,
      unread: detached ? this.currentState.unread : false,
    };
    return this.state();
  }

  jumpToLatest(): ThreadScrollAction {
    this.currentState = { detached: false, unread: false };
    return "smooth";
  }

  state(): ThreadScrollState {
    return { ...this.currentState };
  }
}
