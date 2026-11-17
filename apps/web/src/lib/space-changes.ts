import type { SpaceChangeKind } from "@rakazo/contracts";
import { queryClient } from "./query";
import type { RpcClient } from "./rpc";

type ReadChangeKind = Exclude<SpaceChangeKind, "computerUpdates">;
/** A procedure as its query key ends, typed so a renamed procedure fails to compile here. */
type Procedure = {
  [Router in keyof RpcClient & string]: readonly [Router, keyof RpcClient[Router] & string];
}[keyof RpcClient & string];

const READS: Record<ReadChangeKind, readonly Procedure[]> = {
  runs: [
    ["runs", "list"],
    ["routines", "history"],
    ["usage", "breakdown"],
  ],
  routines: [["routines", "list"]],
  pages: [
    ["pages", "list"],
    ["pages", "get"],
  ],
};

export const isReadChangeKind = (kind: string): kind is ReadChangeKind =>
  Object.hasOwn(READS, kind);

/** A read of one saved version of a page: its code never changes, so a page change leaves it be. */
function isPinnedVersionRead(options: unknown): boolean {
  const input = (options as { input?: { version?: unknown } } | undefined)?.input;
  return input?.version !== undefined;
}

/** Reads again what the server says may have changed; only screens showing it refetch. */
export function spaceChanged(kind: ReadChangeKind, client = queryClient): Promise<void> {
  const procedures = READS[kind].map((procedure) => procedure.join("."));
  return client.invalidateQueries({
    predicate: ({ queryKey: [path, options] }) =>
      Array.isArray(path) &&
      procedures.includes(path.slice(-2).join(".")) &&
      !(kind === "pages" && isPinnedVersionRead(options)),
  });
}
