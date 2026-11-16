import type { ReactElement } from "react";
import type { InboxRowAction } from "../lib/inbox-swipe";
import type { MobileBotSection } from "../lib/mobile-types";
import type { BotOrganizationUpdate } from "./bot-organize-modal";
import type { InboxChatPreviewProps } from "./inbox-chat-preview";

export type InboxSwipeRowProps = {
  rowKey: string;
  unread?: boolean;
  pinned?: boolean;
  /** Bots only; groups have no finish notifications. */
  notifyOnFinish?: boolean;
  sectionId?: string | null;
  sections: readonly MobileBotSection[];
  preview: InboxChatPreviewProps;
  onAction: (action: InboxRowAction) => void;
  onOrganize: (update: BotOrganizationUpdate) => void;
  onEditSection: (mode: "create" | "rename") => void;
  /** Snoozed until a time still ahead. */
  snoozed?: boolean;
  /** An ISO wake time, or null to unsnooze. Without it the menu offers no snooze. */
  onSnooze?: (until: string | null) => void;
  children: ReactElement;
};

/** Swipe actions and the context menu are iOS list behaviour; other platforms keep the sheet. */
export function InboxSwipeRow({ children }: InboxSwipeRowProps) {
  return children;
}
