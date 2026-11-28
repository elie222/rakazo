import { usePathname } from "expo-router";
import { useState } from "react";
import { useSplitView } from "../../lib/layout/split-view";
import { PickChatPane } from "../inbox/pick-chat-pane";
import type { InboxPaneProps, InboxView } from "./home-screen";
import { HomeSession } from "./home-screen";

/**
 * The Activity tab: the same inbox, showing what needs you, what is running and what finished.
 * On a wide window the list beside the stack shows it, so the tab itself waits for a chat.
 */
export function ActivityRoute() {
  const { split } = useSplitView();
  return split ? <PickChatPane /> : <HomeSession view="activity" />;
}

/** The chat list beside the open chat on a wide window. */
export function InboxPane({ onSelectSpace, onShareSelect }: InboxPaneProps) {
  // Beside the stack, the list follows the Chats and Activity tabs, and keeps showing the last
  // one while a chat opened from it fills the stack.
  const pathname = usePathname();
  const [view, setView] = useState<InboxView>("chats");
  const tab = onShareSelect
    ? "chats"
    : pathname === "/activity"
      ? "activity"
      : pathname === "/"
        ? "chats"
        : view;
  if (tab !== view) setView(tab);
  return (
    <HomeSession embedded view={view} onSelectSpace={onSelectSpace} onShareSelect={onShareSelect} />
  );
}
