import type { MobileGroup, MobileSnapshot } from "../api/mobile-types";

function equalValue(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true;
  if (!previous || !next || typeof previous !== "object" || typeof next !== "object") {
    return false;
  }
  if (Array.isArray(previous) || Array.isArray(next)) {
    return (
      Array.isArray(previous) &&
      Array.isArray(next) &&
      previous.length === next.length &&
      previous.every((value, index) => equalValue(value, next[index]))
    );
  }
  const previousRecord = previous as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const keys = Object.keys(previousRecord);
  return (
    keys.length === Object.keys(nextRecord).length &&
    keys.every(
      (key) => Object.hasOwn(nextRecord, key) && equalValue(previousRecord[key], nextRecord[key]),
    )
  );
}

/**
 * Compare projected screen snapshots; the replay cursor stays current in snapRef. A changed
 * snapshot keeps each unchanged message's object, and every other unchanged field (a group's
 * members reach every row), so a row whose inputs did not change is not drawn again.
 */
export function reconcileVisibleThreadSnapshot(
  previous: MobileSnapshot | null,
  next: MobileSnapshot | null,
): MobileSnapshot | null {
  if (previous === next || !previous || !next) return next;
  const { cursor: _previousCursor, ...previousVisible } = previous;
  const { cursor: _nextCursor, ...nextVisible } = next;
  if (equalValue(previousVisible, nextVisible)) return previous;
  const shown = new Map(previous.messages.map((message) => [message.id, message]));
  let kept = 0;
  const messages = next.messages.map((message) => {
    const before = shown.get(message.id);
    if (!before || !equalValue(before, message)) return message;
    kept += 1;
    return before;
  });
  const unchanged =
    kept === previous.messages.length &&
    messages.every((message, index) => message === previous.messages[index]);
  const before = previous as Record<string, unknown>;
  const fields = Object.entries(next).filter(
    ([key, value]) =>
      key !== "messages" &&
      key !== "cursor" &&
      value !== before[key] &&
      equalValue(before[key], value),
  );
  if (kept === 0 && fields.length === 0) return next;
  return {
    ...next,
    ...Object.fromEntries(fields.map(([key]) => [key, before[key]])),
    messages: unchanged ? previous.messages : kept === 0 ? next.messages : messages,
  };
}

/** A group chat's members in its order, once the chat or its group list has loaded them. */
export function threadGroupMembers(
  groupId: string | undefined,
  snap: Pick<MobileSnapshot, "members"> | null,
  groups: readonly Pick<MobileGroup, "id" | "members">[],
) {
  return groupId
    ? (snap?.members ?? groups.find((group) => group.id === groupId)?.members)
    : undefined;
}
