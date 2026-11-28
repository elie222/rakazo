import { GROUP_MEMBER_MAX } from "@rakazo/contracts";

type DraggedBot = { id: string; sectionId: string | null; pinned: boolean };

export type RosterDropTarget =
  | { kind: "bot"; chat: { id: string; sectionId: string | null; pinned: boolean } }
  | { kind: "group"; chat: { id: string; memberIds: readonly string[] } }
  | { kind: "section"; sectionId: string | null };

export type RosterDropAction =
  | { action: "reorder"; targetBotId: string }
  | { action: "move"; sectionId: string | null }
  | { action: "join"; groupId: string; botIds: string[] };

/** A sidebar row or section header a dragged bot can be held over. */
export type RosterDropSlot = {
  /** The Space whose list holds it. */
  spaceId: string;
  /** What it takes as a drop, or null when it takes none. */
  target: RosterDropTarget | null;
  /** The bots listed with it, in order, for reordering. */
  groupBotIds: string[];
  /** A section header: dropping there moves the bot, never reorders it. */
  header: boolean;
};

type SlotGroup = {
  key: string;
  spaceId: string;
  sectionId: string | null;
  emptySpaceId?: string;
  bots: readonly (
    | {
        kind: "bot";
        chat: { id: string; spaceId: string; sectionId: string | null; pinned: boolean };
      }
    | {
        kind: "group";
        chat: { id: string; spaceId: string; members: readonly { botId: string }[] };
      }
  )[];
};

export const rosterHeaderDropKey = (groupKey: string) => `header:${groupKey}`;
export const rosterRowDropKey = (kind: "bot" | "group", id: string) => `row:${kind}:${id}`;

/**
 * Every row and section header of the sidebar, keyed as the roster marks them, with what each
 * takes as a drop. Only the active Space's lists take drops; other Spaces are read-only here.
 */
export function rosterDropSlots(
  groups: readonly SlotGroup[],
  activeSpaceId: string | undefined,
): Map<string, RosterDropSlot> {
  const slots = new Map<string, RosterDropSlot>();
  for (const group of groups) {
    const groupBotIds = group.bots.flatMap((item) => (item.kind === "bot" ? [item.chat.id] : []));
    const active = group.spaceId === activeSpaceId;
    slots.set(rosterHeaderDropKey(group.key), {
      spaceId: group.spaceId,
      target:
        active && !group.emptySpaceId && (group.sectionId || group.key.endsWith("unassigned"))
          ? { kind: "section", sectionId: group.sectionId }
          : null,
      groupBotIds,
      header: true,
    });
    for (const item of group.bots) {
      slots.set(rosterRowDropKey(item.kind, item.chat.id), {
        spaceId: group.spaceId,
        target:
          item.chat.spaceId !== activeSpaceId
            ? null
            : item.kind === "bot"
              ? { kind: "bot", chat: item.chat }
              : {
                  kind: "group",
                  chat: {
                    id: item.chat.id,
                    memberIds: item.chat.members.map((member) => member.botId),
                  },
                },
        groupBotIds,
        header: false,
      });
    }
  }
  return slots;
}

/**
 * Decide what dropping a dragged bot on a sidebar target does. Dropping on a
 * sibling row reorders; dropping on another section (its header or one of its
 * rows) moves the bot there; dropping on a group chat adds the bot as a member.
 * Pinned bots live in the Pinned list, so they only reorder. Returns null when
 * the drop should be refused.
 */
export function resolveRosterDrop(input: {
  dragged: DraggedBot;
  target: RosterDropTarget;
  /** True when the target and dragged rows belong to the same visible list. */
  sameList: boolean;
}): RosterDropAction | null {
  const { dragged, target } = input;
  switch (target.kind) {
    case "bot": {
      if (target.chat.id === dragged.id) return null;
      if (dragged.pinned !== target.chat.pinned) return null;
      if (dragged.pinned || target.chat.sectionId === dragged.sectionId) {
        return input.sameList ? { action: "reorder", targetBotId: target.chat.id } : null;
      }
      return { action: "move", sectionId: target.chat.sectionId };
    }
    case "section": {
      if (dragged.pinned || target.sectionId === dragged.sectionId) return null;
      return { action: "move", sectionId: target.sectionId };
    }
    case "group": {
      const members = target.chat.memberIds;
      if (members.includes(dragged.id) || members.length >= GROUP_MEMBER_MAX) return null;
      return { action: "join", groupId: target.chat.id, botIds: [...members, dragged.id] };
    }
  }
}
