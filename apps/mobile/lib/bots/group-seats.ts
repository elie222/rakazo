/** A seat in the group title's avatar row, at the header avatar's size. */
export const GROUP_SEAT_SIZE = 28;
/** Up to this many members get a seat; a bigger group shows one fewer and a "+N" seat. */
export const GROUP_SEAT_LIMIT = 4;
/** How much of a seat the next one covers. */
const SEAT_OVERLAP = 0.375;

export type GroupSeat<Member> =
  | { kind: "member"; member: Member }
  | { kind: "more"; count: number }
  | { kind: "group" };

/**
 * The seats a group's title shows, in the group's member order. A group's own "#" mark
 * follows a lone member, and stands alone for a group with nobody left.
 */
export function groupSeats<Member>(members: readonly Member[]): GroupSeat<Member>[] {
  if (members.length === 0) return [{ kind: "group" }];
  if (members.length === 1) return [{ kind: "member", member: members[0]! }, { kind: "group" }];
  if (members.length <= GROUP_SEAT_LIMIT) {
    return members.map((member) => ({ kind: "member", member }));
  }
  const shown = GROUP_SEAT_LIMIT - 1;
  return [
    ...members.slice(0, shown).map((member) => ({ kind: "member" as const, member })),
    { kind: "more", count: members.length - shown },
  ];
}

/** How far each seat sits from the one before it. */
export function groupSeatStep(size = GROUP_SEAT_SIZE): number {
  return size * (1 - SEAT_OVERLAP);
}

/** The row's width for this many seats, so the title can hold its place before they draw. */
export function groupSeatsWidth(seats: number, size = GROUP_SEAT_SIZE): number {
  return seats > 0 ? size + (seats - 1) * groupSeatStep(size) : 0;
}

/** The clear gap cut around a seat where it covers the one before it. */
export function groupSeatGap(size = GROUP_SEAT_SIZE): number {
  return (2 * size) / 36;
}
