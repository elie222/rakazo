import type { MobileBot, MobileGroup } from "./api";
import { rpc } from "./api";

/** Archived bots and groups load independently, so one failing list doesn't hide the other. */
export async function loadArchivedChats(signal?: AbortSignal): Promise<{
  bots: MobileBot[] | null;
  groups: MobileGroup[] | null;
  error: unknown;
}> {
  const [bots, groups] = await Promise.allSettled([
    rpc<MobileBot[]>("bots/listArchived", {}, { signal }),
    rpc<MobileGroup[]>("groups/listArchived", {}, { signal }),
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
