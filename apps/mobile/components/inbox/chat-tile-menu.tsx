import type { ReactElement } from "react";
import type { InboxSwipeRowProps } from "./inbox-swipe-row";

export type ChatTileMenuProps = Omit<InboxSwipeRowProps, "rowKey"> & {
  /** The tile's width, which its native host is laid out at. */
  width: number | undefined;
  children: ReactElement;
};

/** A pinned tile's context menu is iOS behaviour; other platforms organize with a long press. */
export function ChatTileMenu({ children }: ChatTileMenuProps) {
  return children;
}
