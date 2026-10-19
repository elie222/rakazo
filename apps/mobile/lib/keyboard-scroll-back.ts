/** The content-offset direction that moves a list toward older messages. */
export type OlderDirection = "increasing" | "decreasing";

const THRESHOLD = 8;

/**
 * iOS `keyboardDismissMode="interactive"` only hides the keyboard when the finger drags into
 * it; a scroll over the messages above it never reaches it, so this flags the first drag
 * toward older messages so the caller can dismiss the keyboard itself.
 */
export class KeyboardScrollBack {
  private dragStart: number | null = null;

  constructor(private readonly older: OlderDirection) {}

  onDragStart(offset: number): void {
    this.dragStart = offset;
  }

  onScroll(offset: number): boolean {
    if (this.dragStart === null) return false;
    const delta = offset - this.dragStart;
    const towardOlder = this.older === "increasing" ? delta : -delta;
    if (towardOlder <= THRESHOLD) return false;
    this.dragStart = null;
    return true;
  }

  onDragEnd(): void {
    this.dragStart = null;
  }
}
