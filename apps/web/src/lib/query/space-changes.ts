import type { RpcPath, SpaceChangeKind } from "@rakazo/contracts";
import { DEPLOYMENT_MODEL_READS } from "@rakazo/contracts";
import { queryClient } from "./query";

type ReadChangeKind = Exclude<SpaceChangeKind, "computerUpdates">;
const READS: Record<ReadChangeKind, readonly RpcPath[]> = {
  runs: ["runs/list", "routines/history", "usage/breakdown"],
  routines: ["routines/list"],
  meetingCalendar: ["meetingCalendar/upcoming"],
  meetings: ["meetings/list", "meetings/transcript"],
  artifacts: ["artifacts/listSpace"],
  deploymentModel: DEPLOYMENT_MODEL_READS,
};

export const isReadChangeKind = (kind: string): kind is ReadChangeKind =>
  Object.hasOwn(READS, kind);

/** Reads again what the server says may have changed; only screens showing it refetch. */
export function spaceChanged(kind: ReadChangeKind, client = queryClient): Promise<void> {
  return client.invalidateQueries({
    // Space RPC query paths start with the user and Space scopes.
    predicate: ({ queryKey: [path] }) =>
      Array.isArray(path) && READS[kind].some((procedure) => procedure === path.slice(2).join("/")),
  });
}
