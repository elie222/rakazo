import { isRunWaitingOnUser, isRunWorking } from "@rakazo/core";

/** A seat in the group title's creature stack, at the header avatar's size. */
export const GROUP_SEAT_SIZE = 34;
/** The stack shows up to this many members; the rest are counted beside it as "+N". */
export const GROUP_SEAT_LIMIT = 3;
/** How much of a seat the next one tucks under: 12pt of a 34pt seat. */
const SEAT_OVERLAP = 12 / 34;

export type GroupSeat<Member> = { kind: "member"; member: Member } | { kind: "group" };

type StatusMember = { name?: string; status?: string };

/** What the group title's second line says, when a member needs the user or is working. */
export type GroupTitleStatus = { kind: "needsYou" | "working"; name: string };

/** A bot asking the user comes first, then bots at work, then everyone else in group order. */
function attentionRank(member: StatusMember): number {
  if (isRunWaitingOnUser(member.status)) return 0;
  if (isRunWorking(member.status)) return 1;
  return 2;
}

/** A group's members with the one that needs the user first, then those working, then the rest. */
export function membersByAttention<Member extends StatusMember>(
  members: readonly Member[],
): Member[] {
  return members
    .map((member, index) => ({ member, index }))
    .sort((a, b) => attentionRank(a.member) - attentionRank(b.member) || a.index - b.index)
    .map(({ member }) => member);
}

/**
 * The group title's stack and count. The bot that needs the user, or else one that is working,
 * moves to the front; up to three members show and the rest become the count. A lone member is
 * followed by the group's "#" mark so the title still reads as a group, and a group with nobody
 * left shows the mark alone.
 */
export function groupTitleSeats<Member extends StatusMember>(
  members: readonly Member[],
): { seats: GroupSeat<Member>[]; more: number } {
  if (members.length === 0) return { seats: [{ kind: "group" }], more: 0 };
  if (members.length === 1) {
    return { seats: [{ kind: "member", member: members[0]! }, { kind: "group" }], more: 0 };
  }
  const ordered = membersByAttention(members);
  return {
    seats: ordered.slice(0, GROUP_SEAT_LIMIT).map((member) => ({ kind: "member", member })),
    more: Math.max(0, ordered.length - GROUP_SEAT_LIMIT),
  };
}

/** The group title's second line: a bot that needs the user wins over one that is working. */
export function groupTitleStatus(members: readonly StatusMember[]): GroupTitleStatus | null {
  const needsYou = members.find((member) => member.name && isRunWaitingOnUser(member.status));
  if (needsYou?.name) return { kind: "needsYou", name: needsYou.name };
  const working = members.find((member) => member.name && isRunWorking(member.status));
  if (working?.name) return { kind: "working", name: working.name };
  return null;
}

/** How far each seat sits from the one before it. */
export function groupSeatStep(size = GROUP_SEAT_SIZE): number {
  return size * (1 - SEAT_OVERLAP);
}

/** The stack's width for this many seats, so the title can hold its place before they draw. */
export function groupSeatsWidth(seats: number, size = GROUP_SEAT_SIZE): number {
  return seats > 0 ? size + (seats - 1) * groupSeatStep(size) : 0;
}

/** The clear gap cut around a seat where it covers the one behind it. */
export function groupSeatGap(size = GROUP_SEAT_SIZE): number {
  return (2 * size) / 36;
}

/** Header layout: the screen inset, the circle buttons and the gap between a circle and the pill. */
const HEADER_INSET = 16;
const HEADER_CIRCLE = 48;
const HEADER_GAP = 8;

/**
 * The width a group's title pill fills on Android: the chat pane less its insets and the circle
 * (with its gap) on each side that has one.
 */
export function groupTitleWidth(
  paneWidth: number,
  { leading, trailing }: { leading: boolean; trailing: boolean },
): number {
  const circle = HEADER_CIRCLE + HEADER_GAP;
  return Math.max(
    0,
    paneWidth - 2 * HEADER_INSET - (leading ? circle : 0) - (trailing ? circle : 0),
  );
}

/** One face or the "+N" chip in a group's list avatar, placed within its square. */
export type GroupAvatarTile<Member> =
  | { kind: "member"; member: Member; left: number; top: number; size: number }
  | { kind: "more"; count: number; left: number; top: number; size: number };

/**
 * A group's avatar in the chat list, in a square of `size`: two members sit as a diagonal
 * pair, three as a triangle (one above, two below), and a bigger group gives the third place
 * to a "+N" chip. The member needing the user, or else one working, takes the top place, and
 * earlier tiles sit above later ones.
 */
export function groupAvatarTiles<Member extends StatusMember>(
  members: readonly Member[],
  size: number,
): GroupAvatarTile<Member>[] {
  const ordered = membersByAttention(members);
  if (ordered.length === 2) {
    const face = Math.round(size * (33 / 52));
    return ordered.map((member, index) => ({
      kind: "member",
      member,
      left: index * (size - face),
      top: index * (size - face),
      size: face,
    }));
  }
  const face = Math.round(size * (29 / 52));
  const below = size - face;
  const places = [
    { left: Math.floor(below / 2), top: 0 },
    { left: 0, top: below },
    { left: below, top: below },
  ];
  const shown = ordered.length > 3 ? ordered.slice(0, 2) : ordered.slice(0, 3);
  const tiles: GroupAvatarTile<Member>[] = shown.map((member, index) => ({
    kind: "member",
    member,
    ...places[index]!,
    size: face,
  }));
  if (ordered.length > 3) {
    tiles.push({ kind: "more", count: ordered.length - 2, ...places[2]!, size: face });
  }
  return tiles;
}
