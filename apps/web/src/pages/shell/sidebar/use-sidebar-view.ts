import { useLingui } from "@lingui/react/macro";
import type { Bot, BotSection, Group, Me, Space } from "@rakazo/contracts";
import { chatSnoozed } from "@rakazo/core";
import { useMemo, useState } from "react";
import { useDesktopBadge } from "../../../lib/platform/use-desktop-badge";
import {
  readBotsSidebarCollapsed,
  writeBotsSidebarCollapsed,
} from "../../../lib/preferences/bots-sidebar-pref";
import type { SnoozedChat } from "./snoozed-chats";
import { countUnreadChats, sidebarGroupsForSpaces } from "./space-sidebar";

/**
 * What the sidebar shows: whether it is collapsed, every space's chats grouped for the roster, the
 * snoozed ones, and the unread count on the Dock badge.
 */
export function useSidebarView({
  userId,
  isMobile,
  bootstrapMe,
  spaces,
  bots,
  groups,
  botSections,
  searchQuery,
  now,
}: {
  userId: string | undefined;
  isMobile: boolean;
  bootstrapMe: Me | null | undefined;
  spaces: Space[];
  bots: Bot[];
  groups: Group[];
  botSections: BotSection[];
  searchQuery: string;
  now: number;
}) {
  const { t } = useLingui();
  // Read while rendering, so returning to chats does not animate the sidebar shut.
  const [collapsed, setCollapsed] = useState(() => readBotsSidebarCollapsed(userId));
  const [collapsedFor, setCollapsedFor] = useState(userId);
  if (collapsedFor !== userId) {
    setCollapsedFor(userId);
    setCollapsed(readBotsSidebarCollapsed(userId));
  }
  function setCollapsedPref(next: boolean) {
    setCollapsed(next);
    writeBotsSidebarCollapsed(userId, next);
  }
  const mini = collapsed && !isMobile;

  const sidebarSpaces = useMemo(
    () =>
      spaces.length > 0
        ? spaces.map((space) =>
            space.id === bootstrapMe?.spaceId ? { ...space, bots, groups, botSections } : space,
          )
        : bootstrapMe
          ? [
              {
                id: bootstrapMe.spaceId,
                name: "Personal",
                isDefault: true,
                hasContent: true,
                canRename: false,
                canDelete: false,
                bots,
                groups,
                botSections,
              },
            ]
          : [],
    [bootstrapMe, botSections, bots, groups, spaces],
  );
  const sidebarGroups = useMemo(
    () =>
      sidebarGroupsForSpaces(
        sidebarSpaces,
        mini ? "" : searchQuery,
        { pinned: t`Pinned`, unassigned: t`Unassigned` },
        now,
      ),
    [sidebarSpaces, searchQuery, mini, t, now],
  );
  // The Dock badge ignores the roster search box: a filter must not hide unread chats.
  const unreadChatCount = useMemo(
    () => countUnreadChats(sidebarGroupsForSpaces(sidebarSpaces, "", undefined, now)),
    [sidebarSpaces, now],
  );
  useDesktopBadge(userId ? unreadChatCount : 0);
  const snoozed: SnoozedChat[] = sidebarSpaces.flatMap((space) => [
    ...space.bots
      .filter((chat) => chatSnoozed(chat, now))
      .map((chat) => ({ kind: "bot" as const, chat })),
    ...space.groups
      .filter((chat) => chatSnoozed(chat, now))
      .map((chat) => ({ kind: "group" as const, chat })),
  ]);

  return { collapsed, setCollapsed, setCollapsedPref, mini, sidebarGroups, snoozed };
}
