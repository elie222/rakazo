import type { SpaceChangeKind } from "@rakazo/contracts";
import { refreshQueriesAfterSignal } from "@rakazo/core";
import type { QueryFilters } from "@tanstack/react-query";
import { queryClient } from "./query";
import type { RpcClient } from "./rpc";

type ReadChangeKind = Exclude<SpaceChangeKind, "computerUpdates">;
/** A procedure as its query key ends, typed so a renamed procedure fails to compile here. */
type Procedure = {
  [Router in keyof RpcClient & string]: readonly [Router, keyof RpcClient[Router] & string];
}[keyof RpcClient & string];

const READS: Record<ReadChangeKind, readonly Procedure[]> = {
  deploymentModel: [],
  preferences: [],
  runs: [
    ["runs", "list"],
    ["routines", "history"],
    ["usage", "breakdown"],
  ],
  routines: [["routines", "list"]],
  nativeCalendar: [],
  meetingCalendar: [["meetingCalendar", "upcoming"]],
  meetings: [
    ["meetings", "list"],
    ["meetings", "transcript"],
  ],
  artifacts: [["artifacts", "listSpace"]],
  pages: [
    ["pages", "get"],
    ["pages", "list"],
    ["pageReviews", "get"],
    ["pageReviews", "list"],
    ["pageReviews", "grants"],
    ["pageReviews", "comments"],
    ["pageReviews", "draft"],
  ],
};

export const isReadChangeKind = (kind: string): kind is ReadChangeKind =>
  Object.hasOwn(READS, kind);

/** Reads again what the server says may have changed; only screens showing it refetch. */
export function spaceChanged(kind: ReadChangeKind, client = queryClient): Promise<void> {
  const procedures = READS[kind].map((procedure) => procedure.join("."));
  const filters: QueryFilters = {
    predicate: ({ queryKey: [path] }) => {
      if (!Array.isArray(path)) return false;
      if (kind === "deploymentModel") return path[2] === "me" || path[2] === "models";
      if (kind === "preferences") return path[2] === "me";
      return procedures.includes(path.slice(-2).join("."));
    },
  };
  return refreshQueriesAfterSignal(client, filters);
}
