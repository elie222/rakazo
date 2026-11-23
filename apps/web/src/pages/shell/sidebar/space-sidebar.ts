import { chatSnoozed, chatWoke, groupBotsForSidebar } from "@rakazo/core";

type SidebarChat = {
  id: string;
  name: string;
  preview?: string | null;
  pinned: boolean;
  sectionId: string | null;
  snoozedUntil?: string | null;
};

type SidebarSpace<TBot extends SidebarChat, TGroup extends SidebarChat> = {
  id: string;
  name: string;
  canRename?: boolean;
  canDelete?: boolean;
  shared?: boolean;
  hasGuests?: boolean;
  bots: readonly TBot[];
  groups: readonly TGroup[];
  botSections: readonly { id: string; name: string }[];
};

export async function commitSpaceRename(input: {
  rename: () => Promise<void>;
  apply: () => void;
  refresh: () => Promise<void>;
}): Promise<void> {
  await input.rename();
  input.apply();
  await input.refresh().catch(() => undefined);
}

export function sidebarGroupsForSpaces<TBot extends SidebarChat, TGroup extends SidebarChat>(
  spaces: readonly SidebarSpace<TBot, TGroup>[],
  query: string,
  labels?: { pinned: string; unassigned: string },
  now = Date.now(),
) {
  const needle = query.toLowerCase();
  const showSpaceNames = spaces.length > 1;
  // Search still finds a snoozed chat; the list itself leaves it out until it wakes.
  const listed = (chat: SidebarChat) =>
    needle
      ? `${chat.name} ${chat.preview ?? ""}`.toLowerCase().includes(needle)
      : !chatSnoozed(chat, now);
  return spaces.flatMap((space) => {
    const visibleBots = space.bots.filter(listed);
    const visibleGroups = space.groups.filter(listed);
    const grouped = groupBotsForSidebar(
      [
        ...visibleBots.map((chat) => ({ kind: "bot" as const, chat })),
        ...visibleGroups.map((chat) => ({ kind: "group" as const, chat })),
      ].map((item) => ({
        ...item,
        id: item.chat.id,
        pinned: item.chat.pinned,
        sectionId: item.chat.sectionId,
        woke: chatWoke(item.chat, now),
      })),
      space.botSections,
      { labels },
    );
    // Keep destinations visible after their last bot is dragged out. Search
    // still hides empty lists, and spaces without sections keep their old layout.
    if (!needle && space.botSections.length > 0 && grouped.length > 0) {
      for (const section of space.botSections) {
        const key = `section:${section.id}`;
        if (!grouped.some((group) => group.key === key)) {
          grouped.push({ key, title: section.name, bots: [] });
        }
      }
      if (!grouped.some((group) => group.key === "unassigned")) {
        grouped.push({ key: "unassigned", title: labels?.unassigned ?? "Unassigned", bots: [] });
      }
      const order = [
        "pinned",
        ...space.botSections.map((section) => `section:${section.id}`),
        "unassigned",
      ];
      grouped.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    }
    // Pinned chats show as tiles under no heading of their own, so without saved sections the
    // list after them is simply the Space's.
    const headed = grouped.map((group) =>
      group.key === "pinned" || (group.key === "unassigned" && space.botSections.length === 0)
        ? { ...group, title: null }
        : group,
    );
    // A Space whose chats are all pinned keeps its name above the tiles.
    const listIndex = headed.findIndex((group) => group.key !== "pinned");
    const firstHeader = showSpaceNames || listIndex < 0 ? 0 : listIndex;
    const sections = headed.map((group, index) => ({
      ...group,
      tiles: group.key === "pinned",
      sectionId: group.key.startsWith("section:") ? group.key.slice("section:".length) : null,
      key: showSpaceNames ? `space:${space.id}:${group.key}` : group.key,
      // The first header needs a title so it can host the Space settings button.
      title: showSpaceNames
        ? space.name
        : index === firstHeader && !group.title
          ? space.name
          : group.title,
      subtitle: showSpaceNames && group.title ? group.title : undefined,
      showLock: showSpaceNames,
      shared: space.shared === true,
      // Once per Space: every heading that names it, or a lone Space's first heading.
      hasGuests: space.hasGuests === true && (showSpaceNames || index === firstHeader),
      emptySpaceId: undefined as string | undefined,
      spaceId: space.id,
      spaceName: space.name,
      canOpenSpaceSettings: index === firstHeader,
    }));
    if (sections.length > 0) return sections;
    // Keep empty spaces selectable; chat clicks are the only switch control.
    if (needle && (space.bots.length > 0 || space.groups.length > 0)) return [];
    // Saved sections stay listed under the placeholder so they can still be
    // renamed or deleted after their last chat leaves.
    const emptySections = needle
      ? []
      : space.botSections.map((section) => ({
          key: showSpaceNames ? `space:${space.id}:section:${section.id}` : `section:${section.id}`,
          title: showSpaceNames ? space.name : section.name,
          subtitle: showSpaceNames ? section.name : undefined,
          bots: [] as (typeof sections)[number]["bots"],
          tiles: false,
          sectionId: section.id as string | null,
          showLock: showSpaceNames,
          shared: space.shared === true,
          hasGuests: space.hasGuests === true && showSpaceNames,
          emptySpaceId: undefined as string | undefined,
          spaceId: space.id,
          spaceName: space.name,
          canOpenSpaceSettings: false,
        }));
    // A lone space is the selected one, so its settings stay in the account menu too.
    const lone = !showSpaceNames && !space.canRename && !space.canDelete;
    if (lone && (needle || emptySections.length > 0)) {
      return emptySections;
    }
    return [
      {
        key: showSpaceNames ? `space:${space.id}:empty` : `space:${space.id}:actions`,
        title: space.name,
        subtitle: undefined,
        bots: [],
        tiles: false,
        sectionId: null,
        showLock: showSpaceNames,
        shared: space.shared === true,
        hasGuests: space.hasGuests === true,
        emptySpaceId: showSpaceNames ? space.id : undefined,
        spaceId: space.id,
        spaceName: space.name,
        canOpenSpaceSettings: true,
      },
      ...emptySections,
    ];
  });
}

/** Count the unread flags the roster renders. Pass unfiltered groups for the app badge. */
export function countUnreadChats(
  sections: readonly { bots: readonly { chat: { unread?: boolean } }[] }[],
): number {
  return sections.reduce(
    (count, section) => count + section.bots.filter((item) => item.chat.unread).length,
    0,
  );
}
