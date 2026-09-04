import type { ReactNode } from "react";

/** Side of the bubble that hosts the hover icon rail (Grok Bot geometry). */
export type MessageHoverSide = "start" | "end";

/**
 * Hover chrome for a chat bubble: muted outline icons sit flush beside the
 * bubble (vertically centered), not under it and not overlaid on the text.
 * Hidden at rest. Shown only for real hover pointers (hover + fine), or when
 * focus moves inside the rail, or while pinned (More open). Touch/coarse
 * pointers do not sticky-reveal the rail.
 * No timestamp here. Time, if shown, lives in the More menu.
 */
export function MessageHoverMetadata({
  side,
  pinned = false,
  children,
}: {
  side: MessageHoverSide;
  /** Keep the rail visible while a menu inside it is open. */
  pinned?: boolean;
  children: ReactNode;
}) {
  // Hover reveal is gated on a real hover media query so touch agents that
  // synthesize :hover do not leave the icons stuck painted.
  const hoverReveal =
    "[@media(hover:hover)_and_(pointer:fine)]:group-hover/message:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover/message:opacity-100";
  const reveal = pinned
    ? "pointer-events-auto opacity-100"
    : `opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 ${hoverReveal}`;

  return (
    <div
      data-testid="message-hover-rail"
      className={`pointer-events-none absolute top-1/2 z-10 flex -translate-y-1/2 items-center transition-opacity ${reveal} ${
        // A few pixels off the bubble edge (Grok Bot), not a reserved column.
        side === "end" ? "start-full ms-1" : "end-full me-1"
      }`}
    >
      {children}
    </div>
  );
}
