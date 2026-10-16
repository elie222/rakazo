import type { ReactElement } from "react";
import type { InboxRowAction } from "../lib/inbox-swipe";

export type InboxSwipeRowProps = {
  rowKey: string;
  unread?: boolean;
  pinned?: boolean;
  onAction: (action: InboxRowAction) => void;
  children: ReactElement;
};

/** Swipe actions are iOS list behaviour; other platforms keep the long-press menu only. */
export function InboxSwipeRow({ children }: InboxSwipeRowProps) {
  return children;
}
