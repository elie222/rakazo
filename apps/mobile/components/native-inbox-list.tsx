import type { ReactElement, ReactNode } from "react";
import type { AvatarViewport } from "../lib/avatar-life";

export type NativeInboxListProps<Item> = {
  data: readonly Item[];
  keyExtractor: (item: Item) => string;
  renderItem: (info: { item: Item }) => ReactElement | null;
  /** Rows that bring their own swipe actions and menu, and so join the list directly. */
  isSwipeRow: (item: Item) => boolean;
  header?: ReactNode;
  /** Shown in place of the rows while there are none. */
  empty?: ReactNode;
  footer?: ReactNode;
  /** Space beside the rows, beyond the safe area the list keeps, for a readable column. */
  gutters: { left: number; right: number };
  avatarViewport: AvatarViewport;
  onRefresh: () => Promise<void>;
};

/** iOS only: other platforms keep the FlatList inbox. */
export function NativeInboxList<Item>(_props: NativeInboxListProps<Item>): ReactElement | null {
  return null;
}
