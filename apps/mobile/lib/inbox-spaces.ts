import type { SpaceBot, SpaceGroup } from "@rakazo/contracts";
import { groupBotsForSidebar } from "@rakazo/core";
import {
  adoptDeletedSpaceFallback,
  type MobileBot,
  type MobileGroup,
  type MobileSpace,
  rpc,
  selectedSpaceId,
  selectSpace,
} from "./api";

export type InboxSpace = Pick<
  MobileSpace,
  "id" | "name" | "isDefault" | "hasContent" | "canDelete" | "botSections"
> & {
  bots: (MobileBot | SpaceBot)[];
  groups: (MobileGroup | SpaceGroup)[];
};

export type InboxSpaceItem =
  | { type: "bot"; bot: MobileBot | SpaceBot }
  | { type: "group"; group: MobileGroup | SpaceGroup }
  | { type: "heading"; key: string; title: string; space?: InboxSpace };

export function canDeleteInboxSpace(
  space: Pick<InboxSpace, "isDefault" | "hasContent" | "canDelete">,
) {
  return !space.isDefault && !space.hasContent && space.canDelete === true;
}

export function spaceInboxItems(spaces: InboxSpace[]): InboxSpaceItem[] {
  return spaces.flatMap((space): InboxSpaceItem[] => {
    const chats = [
      ...space.bots.map((chat) => ({ type: "bot" as const, bot: chat, ...chat })),
      ...space.groups.map((chat) => ({ type: "group" as const, group: chat, ...chat })),
    ];
    const items: InboxSpaceItem[] = [];
    if (spaces.length > 1 || !space.isDefault || chats.length === 0) {
      items.push({ type: "heading", key: space.id, title: space.name, space });
    }
    for (const group of groupBotsForSidebar(chats, space.botSections)) {
      if (group.title) {
        items.push({ type: "heading", key: `${space.id}:${group.key}`, title: group.title });
      }
      items.push(...group.bots);
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
  const response = await rpc<{ ok: true; activeSpaceId: string }>("spaces/remove", { spaceId });
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
