import type { ThreadSnapshot } from "@rakazo/contracts";
import type { LogoAvatarActivitySnapshot } from "@rakazo/core";
import { createLogoAvatarActivityStore } from "@rakazo/core";

const projection = createLogoAvatarActivityStore();
const snapshots = new Map<string, { value: LogoAvatarActivitySnapshot; order: number }>();
let snapshotOrder = 0;
let sessionScope = "";
let serial = 0;
export const mobileLogoAvatarActivity = {
  ...projection,
  clear() {
    snapshots.clear();
    projection.clear();
  },
};
export function syncMobileAvatarSession(apiBase: string, generation: number) {
  const scope = `${generation}:${apiBase}`;
  if (scope === sessionScope) return;
  sessionScope = scope;
  mobileLogoAvatarActivity.clear();
}
export const newMobileAvatarSnapshotRequest = () => ++snapshotOrder;
export function rememberMobileAvatarSnapshot(
  snapshot: Pick<
    ThreadSnapshot,
    "threadId" | "cursor" | "botId" | "groupId" | "run" | "activeRuns"
  >,
  order = newMobileAvatarSnapshotRequest(),
) {
  const key = snapshot.groupId
    ? `group:${snapshot.groupId}`
    : snapshot.botId
      ? `bot:${snapshot.botId}`
      : null;
  if (!key) return;
  const previous = snapshots.get(key);
  if (
    previous &&
    (previous.order > order ||
      (previous.value.threadId === snapshot.threadId && previous.value.cursor > snapshot.cursor))
  )
    return;
  // Keep only current run metadata, never message contents or historical tool rows.
  snapshots.set(key, {
    order,
    value: {
      threadId: snapshot.threadId,
      cursor: snapshot.cursor,
      botId: snapshot.botId,
      run: snapshot.run,
      activeRuns: snapshot.activeRuns,
    },
  });
  projection.reconcile(snapshots.get(key)!.value);
  if (snapshots.size > 100) snapshots.delete(snapshots.keys().next().value!);
}
export function beginMobileAvatarFeed(
  target: { botId: string } | { groupId: string },
  cursor: number,
) {
  const source = `mobile-avatar-${++serial}`;
  const key = "groupId" in target ? `group:${target.groupId}` : `bot:${target.botId}`;
  const snapshot = snapshots.get(key)?.value;
  if (snapshot)
    projection.hydrate(source, { ...snapshot, cursor: Math.max(snapshot.cursor, cursor) });
  return { source, threadId: snapshot?.threadId };
}
