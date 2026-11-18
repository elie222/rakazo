import type { SpaceChangeKind } from "@rakazo/contracts";
import { queryClient } from "./query";
import type { RpcClient } from "./rpc";

type ReadChangeKind = Exclude<SpaceChangeKind, "computerUpdates">;
/** A procedure as its query key ends, typed so a renamed procedure fails to compile here. */
type Procedure =
  | readonly ["me"]
  | {
      [Router in keyof RpcClient & string]: readonly [Router, keyof RpcClient[Router] & string];
    }[keyof RpcClient & string];

const READS: Record<ReadChangeKind, readonly Procedure[]> = {
  runs: [
    ["runs", "list"],
    ["routines", "history"],
    ["usage", "breakdown"],
  ],
  routines: [["routines", "list"]],
  deploymentModel: [["me"], ["models", "role"], ["models", "sharedDeployment"]],
};

export const isReadChangeKind = (kind: string): kind is ReadChangeKind =>
  Object.hasOwn(READS, kind);

/** Reads again what the server says may have changed; only screens showing it refetch. */
export function spaceChanged(kind: ReadChangeKind, client = queryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: ({ queryKey: [path] }) =>
      Array.isArray(path) &&
      READS[kind].some(
        (procedure) => procedure.join(".") === path.slice(-procedure.length).join("."),
      ),
  });
}
