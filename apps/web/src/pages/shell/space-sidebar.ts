import { groupBotsForSidebar } from "@rakazo/core";

type SidebarChat = {
  id: string;
  name: string;
  title?: string | null;
  preview?: string | null;
  pinned: boolean;
  sectionId: string | null;
  parentBotId?: string | null;
};

type SidebarSpace<TBot extends SidebarChat, TGroup extends SidebarChat> = {
  id: string;
  name: string;
  canRename?: boolean;
  canDelete?: boolean;
  bots: readonly TBot[];
  groups: readonly TGroup[];
  botSections: readonly { id: string; name: string }[];
};

function spaceHeaderMenu(space: { canRename?: boolean; canDelete?: boolean }, hostsMenu: boolean) {
  return {
    canRenameSpace: hostsMenu && space.canRename === true,
    canDeleteSpace: hostsMenu && space.canDelete === true,
  };
}

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
) {
  const needle = query.toLowerCase();
  const showSpaceNames = spaces.length > 1;
  return spaces.flatMap((space) => {
    const visibleBots = space.bots.filter((bot) =>
      `${bot.name} ${bot.title ?? ""} ${bot.preview ?? ""}`.toLowerCase().includes(needle),
    );
    const visibleGroups = space.groups.filter((group) =>
      `${group.name} ${group.preview ?? ""}`.toLowerCase().includes(needle),
    );
    const sections = groupBotsForSidebar(
      [
        ...visibleBots.map((chat) => ({ kind: "bot" as const, chat })),
        ...visibleGroups.map((chat) => ({ kind: "group" as const, chat })),
      ].map((item) => ({
        ...item,
        id: item.chat.id,
        parentBotId: item.kind === "bot" ? (item.chat.parentBotId ?? null) : null,
        pinned: item.chat.pinned,
        sectionId: item.chat.sectionId,
      })),
      space.botSections,
    ).map((group, index) => ({
      ...group,
      sectionId: group.key.startsWith("section:") ? group.key.slice("section:".length) : null,
      key: showSpaceNames ? `space:${space.id}:${group.key}` : group.key,
      title: showSpaceNames
        ? group.title
          ? `${space.name} · ${group.title}`
          : space.name
        : group.title,
      showLock: showSpaceNames,
      emptySpaceId: undefined as string | undefined,
      spaceId: space.id,
      spaceName: space.name,
      ...spaceHeaderMenu(space, index === 0),
    }));
    if (sections.length > 0) return sections;
    // Keep empty spaces selectable; chat clicks are the only switch control.
    if (needle && (space.bots.length > 0 || space.groups.length > 0)) return [];
    if (!showSpaceNames && space.canRename !== true && space.canDelete !== true) return [];
    return [
      {
        key: showSpaceNames ? `space:${space.id}:empty` : `space:${space.id}:actions`,
        title: showSpaceNames ? space.name : null,
        bots: [],
        sectionId: null,
        showLock: showSpaceNames,
        emptySpaceId: showSpaceNames ? space.id : undefined,
        spaceId: space.id,
        spaceName: space.name,
        ...spaceHeaderMenu(space, true),
      },
    ];
  });
}
