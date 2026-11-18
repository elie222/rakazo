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
 * snapshot keeps each unchanged message's object, so its row is not drawn again.
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
  if (kept === 0) return next;
  const unchanged =
    kept === previous.messages.length &&
    messages.every((message, index) => message === previous.messages[index]);
  return { ...next, messages: unchanged ? previous.messages : messages };
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
