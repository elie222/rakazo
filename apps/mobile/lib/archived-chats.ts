import type { ApiRequestContext, MobileBot, MobileGroup } from "./api";
import { captureApiRequestContext, rpc } from "./api";

/** Archived bots and groups load independently, so one failing list doesn't hide the other. */
export async function loadArchivedChats(
  signal?: AbortSignal,
  requestContext?: ApiRequestContext,
): Promise<{
  bots: MobileBot[] | null;
  groups: MobileGroup[] | null;
  error: unknown;
}> {
  const options = requestContext
    ? { signal, requestContext, skipSpaceAuthRecovery: true }
    : { signal };
  const [bots, groups] = await Promise.allSettled([
    rpc("bots/listArchived", {}, options),
    rpc("groups/listArchived", {}, options),
  ]);
  return {
    bots: bots.status === "fulfilled" ? bots.value : null,
    groups: groups.status === "fulfilled" ? groups.value : null,
    error: [bots, groups].find((result) => result.status === "rejected")?.reason,
  };
}

/** A list that failed to load keeps its last known count. */
export function archivedChatCounts(
  previous: { bots: number; groups: number },
  loaded: { bots: unknown[] | null; groups: unknown[] | null },
): { bots: number; groups: number } {
  return {
    bots: loaded.bots?.length ?? previous.bots,
    groups: loaded.groups?.length ?? previous.groups,
  };
}

const changeListeners = new Set<() => void>();

/** Archiving, restoring or deleting an archived chat changes the inbox's archived count. */
export function notifyArchivedChatsChanged() {
  for (const listener of changeListeners) listener();
}

export function onArchivedChatsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** The inbox spans every space, so its archive must do the same. */
export async function loadAllArchivedChats(signal?: AbortSignal) {
  try {
    const context = await captureApiRequestContext();
    const navigation = await rpc("spaces/list", {}, { signal, requestContext: context });
    const loaded = await Promise.all(
      navigation.spaces.map(async (space) => {
        const loaded = await loadArchivedChats(signal, {
          ...context,
          headers: { ...context.headers, "x-rakazo-space-id": space.id },
        });
        return {
          bots: loaded.bots?.map((bot) => ({ ...bot, spaceId: space.id })) ?? null,
          groups: loaded.groups?.map((group) => ({ ...group, spaceId: space.id })) ?? null,
          error: loaded.error,
        };
      }),
    );
    return {
      bots: loaded.some((list) => list.bots === null)
        ? null
        : loaded.flatMap((list) => list.bots ?? []),
      groups: loaded.some((list) => list.groups === null)
        ? null
        : loaded.flatMap((list) => list.groups ?? []),
      error: loaded.find((list) => list.error)?.error,
    };
  } catch (error) {
    return { bots: null, groups: null, error };
  }
}
