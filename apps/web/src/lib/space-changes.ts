import type { SpaceChangeKind } from "@rakazo/contracts";
import { queryClient } from "./query";

type ReadChangeKind = Exclude<SpaceChangeKind, "computerUpdates">;

const READS: Record<ReadChangeKind, readonly string[]> = {
  runs: ["runs.list", "routines.history"],
  routines: ["routines.list"],
};

export const isReadChangeKind = (kind: string): kind is ReadChangeKind =>
  Object.hasOwn(READS, kind);

/** Reads again what the server says may have changed; only screens showing it refetch. */
export function spaceChanged(kind: ReadChangeKind, client = queryClient): Promise<void> {
  const procedures = READS[kind];
  return client.invalidateQueries({
    predicate: ({ queryKey: [path] }) =>
      Array.isArray(path) && procedures.includes(path.slice(-2).join(".")),
  });
}
