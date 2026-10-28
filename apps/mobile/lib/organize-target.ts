import type { SpaceBot, SpaceGroup } from "@rakazo/contracts";
import type { MobileBot, MobileBotSection, MobileGroup, MobileSpace } from "./api";
import { captureApiRequestContext, rpc } from "./api";

export type OrganizeChat = MobileBot | MobileGroup | SpaceBot | SpaceGroup;
export type OrganizeTarget = {
  kind: "bot" | "group";
  id: string;
  spaceId?: string;
  chat: OrganizeChat;
  sections: MobileBotSection[];
};
type ChatLists = { bots: OrganizeChat[]; groups: OrganizeChat[]; botSections: MobileBotSection[] };

/**
 * Finds a chat to organize in its own space: the current inbox or a cached space first, otherwise
 * that space's list. `isCurrent` reports whether the press that asked is still the newest.
 * Throws when the fallback request fails.
 */
export async function findOrganizeTarget(
  kind: "bot" | "group",
  chat: OrganizeChat,
  inbox: { currentSpaceId?: string; current: ChatLists; spaces: MobileSpace[] },
  isCurrent: () => boolean,
): Promise<OrganizeTarget | null> {
  const spaceId = chat.spaceId ?? inbox.currentSpaceId;
  let space: ChatLists | undefined =
    spaceId === inbox.currentSpaceId
      ? inbox.current
      : inbox.spaces.find((space) => space.id === spaceId);
  let target = (kind === "bot" ? space?.bots : space?.groups)?.find((item) => item.id === chat.id);
  if (!target && spaceId) {
    // Independent of inbox polling: only a newer organize press supersedes this request.
    const context = await captureApiRequestContext();
    const navigation = await rpc("spaces/list", undefined, {
      requestContext: { ...context, headers: { ...context.headers, "x-rakazo-space-id": spaceId } },
      skipSpaceAuthRecovery: true,
    });
    if (navigation.current.id !== spaceId) return null;
    space = navigation.current;
    target = (kind === "bot" ? space.bots : space.groups).find((item) => item.id === chat.id);
  }
  if (!space || !target || !isCurrent()) return null;
  return { kind, id: chat.id, spaceId, chat: target, sections: space.botSections };
}
