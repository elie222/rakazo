import type { SpaceBot, SpaceGroup } from "@rakazo/contracts";
import { botAvatarActivity, groupBotsForSidebar, logoAvatarNeedsAttention } from "@rakazo/core";
import type { MobileBot, MobileGroup, MobileSpace } from "./api";
import { adoptDeletedSpaceFallback, rpc, selectedSpaceId, selectSpace } from "./api";
import { t } from "./i18n";
import { mobileLogoAvatarActivity } from "./logo-avatar-activity";
import type { InboxSignal } from "./offscreen-unreads";

export type InboxSpace = Pick<
  MobileSpace,
  "id" | "name" | "isDefault" | "hasContent" | "canDelete" | "botCount" | "botSections"
> & {
  bots: (MobileBot | SpaceBot)[];
  groups: (MobileGroup | SpaceGroup)[];
};

export type InboxSpaceItem =
  | {
      type: "bot";
      bot: MobileBot | SpaceBot;
    }
  | { type: "group"; group: MobileGroup | SpaceGroup }
  | {
      type: "heading";
      key: string;
      title: string;
      space?: InboxSpace;
      sectionId?: string;
      collapsed?: boolean;
      count?: number;
    };

export type PinnedChat =
  | { kind: "bot"; bot: MobileBot | SpaceBot }
  | { kind: "group"; group: MobileGroup | SpaceGroup };
export type InboxItem = InboxSpaceItem | { type: "pinned"; chats: PinnedChat[] };

/** What a chat adds to the off-screen unread pills: unread, and a bot waiting on you. */
function chatSignal(chat: PinnedChat): InboxSignal {
  return chat.kind === "bot"
    ? {
        unread: chat.bot.unread ? 1 : 0,
        attention: logoAvatarNeedsAttention(
          botAvatarActivity(
            chat.bot,
            mobileLogoAvatarActivity.getActivity(chat.bot.id, chat.bot.status),
          ),
        )
          ? 1
          : 0,
      }
    : { unread: chat.group.unread ? 1 : 0, attention: 0 };
}

export function inboxItemKey(item: InboxItem): string {
  if (item.type === "pinned") return "pinned";
  if (item.type === "heading") return `heading-${item.key}`;
  if (item.type === "bot") return item.bot.id;
  return `group-${item.group.id}`;
}

export function inboxSignal(item: InboxItem): InboxSignal {
  if (item.type === "heading") return { unread: 0, attention: 0 };
  if (item.type === "bot") return chatSignal({ kind: "bot", bot: item.bot });
  if (item.type === "group") return chatSignal({ kind: "group", group: item.group });
  return item.chats.map(chatSignal).reduce(
    (total, signal) => ({
      unread: total.unread + signal.unread,
      attention: total.attention + signal.attention,
    }),
    { unread: 0, attention: 0 },
  );
}

export function canDeleteInboxSpace(space: Pick<InboxSpace, "isDefault" | "canDelete">) {
  return !space.isDefault && space.canDelete === true;
}

/** Names every bot that goes with the space, archived and other members' included. */
export function deleteSpaceTitle(space: Pick<InboxSpace, "name" | "botCount" | "bots">) {
  // Servers before botCount only listed the member's active bots.
  const bots = space.botCount ?? space.bots.length;
  if (bots === 0) return t("Delete {name}?", { name: space.name });
  if (bots === 1) return t("Delete {name} and its bot?", { name: space.name });
  return t("Delete {name} and its {count} bots?", { name: space.name, count: bots });
}

/** Only headings with no chats under them, counting chats in collapsed sections. */
export function inboxHasNoChats(items: readonly { type: string; count?: number }[]): boolean {
  return items.every((item) => item.type === "heading" && !item.count);
}

/** A brand-new space renders only its heading until it has a bot or group. */
export function inboxNeedsCreateHint(items: readonly { type: string; count?: number }[]): boolean {
  return items.length > 0 && inboxHasNoChats(items);
}

/** `collapsed` holds section heading keys. */
export function spaceInboxItems(
  spaces: InboxSpace[],
  collapsed: ReadonlySet<string> = new Set(),
  editableSpaceId?: string,
): InboxSpaceItem[] {
  return spaces.flatMap((space): InboxSpaceItem[] => {
    const chats = [
      ...space.bots.map((chat) => ({
        type: "bot" as const,
        bot: chat,
        id: chat.id,
        pinned: chat.pinned,
        sectionId: chat.sectionId,
      })),
      ...space.groups.map((chat) => ({
        type: "group" as const,
        group: chat,
        id: chat.id,
        pinned: chat.pinned,
        sectionId: chat.sectionId,
      })),
    ];
    const items: InboxSpaceItem[] = [];
    if (spaces.length > 1 || !space.isDefault || chats.length === 0) {
      items.push({ type: "heading", key: space.id, title: space.name, space });
    }
    for (const group of groupBotsForSidebar(chats, space.botSections, {
      includeEmptySections: true,
      labels: { pinned: t("Pinned"), unassigned: t("Unassigned") },
    })) {
      if (group.title) {
        const key = `${space.id}:${group.key}`;
        items.push({
          type: "heading",
          key,
          title: group.title,
          ...(space.id === editableSpaceId && group.key.startsWith("section:")
            ? { sectionId: group.key.slice("section:".length) }
            : {}),
          collapsed: collapsed.has(key),
          count: group.bots.length,
        });
        if (collapsed.has(key)) continue;
      }
      for (const item of group.bots) {
        if (item.type === "bot") {
          items.push({ type: "bot", bot: item.bot });
        } else {
          items.push({ type: "group", group: item.group });
        }
      }
    }
    return items;
  });
}

export async function selectInboxSpace(spaceId: string, refresh: () => Promise<void>) {
  if (!(await selectSpace(spaceId).catch(() => false))) return false;
  await refresh();
  return true;
}

export async function retryInboxSpaceFallback(spaceId: string, refresh: () => Promise<void>) {
  if (!(await adoptDeletedSpaceFallback(spaceId))) return false;
  await refresh();
  return true;
}

// Return the selection to retry if native storage fails after a successful deletion.
// The inbox must not refresh against the deleted selection in that case.
export async function removeInboxSpace(
  spaceId: string,
  refresh: () => Promise<void>,
): Promise<string | null> {
  const response = await rpc("spaces/remove", { spaceId });
  if (selectedSpaceId() === spaceId) {
    if (await selectSpace(response.activeSpaceId).catch(() => false)) {
      await refresh();
      return null;
    }
    const durable = await adoptDeletedSpaceFallback(response.activeSpaceId);
    await refresh();
    return durable ? null : response.activeSpaceId;
  }
  await refresh();
  return null;
}
