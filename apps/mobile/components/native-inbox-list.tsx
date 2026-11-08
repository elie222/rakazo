import type { ReactElement, ReactNode } from "react";
import type { AvatarViewport } from "../lib/avatar-life";
import type { InboxSignal } from "../lib/offscreen-unreads";

export type NativeInboxListProps<Item> = {
  data: readonly Item[];
  keyExtractor: (item: Item) => string;
  renderItem: (info: { item: Item }) => ReactElement | null;
  /** Rows that make their own native row (chat rows with swipe actions, headings with a menu). */
  isNativeRow: (item: Item) => boolean;
  header?: ReactNode;
  /** Shown in place of the rows while there are none. */
  empty?: ReactNode;
  footer?: ReactNode;
  /** Space beside the rows, beyond the safe area the list keeps, for a readable column. */
  gutters: { left: number; right: number };
  avatarViewport: AvatarViewport;
  onRefresh: () => Promise<void>;
  /** Unread and attention counts by row, for the pills that jump to rows out of view. */
  signals: readonly InboxSignal[];
  showJumpPills: boolean;
};

/** iOS only: other platforms keep the FlatList inbox. */
export function NativeInboxList<Item>(_props: NativeInboxListProps<Item>): ReactElement | null {
  return null;
}
