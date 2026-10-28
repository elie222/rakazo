import type { RpcInput, RpcOutput, RpcPath } from "@rakazo/contracts";
import type { DataTag, QueryFunction, QueryKey } from "@tanstack/react-query";
import { QueryClient } from "@tanstack/react-query";
import type { RpcArgs } from "./api";
import { captureApiRequestContext, currentApiBase, rpc, selectedSpaceId } from "./api";
import { t } from "./i18n";
import { currentSessionGeneration } from "./session";

/**
 * Screens paint what they last saw and refresh it in the background, so reopening a settings
 * screen does not wait on the network again. Kept in memory only; saved chats own the disk.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 30 * 60_000,
      // Screens refresh when they gain focus, and rpc already bounds each request.
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

/**
 * The server, signed-in session, and space a read belongs to. A session change (sign-in,
 * sign-out, server switch) also clears the cache, so data never crosses an auth boundary.
 */
function scopeKey(spaceId?: string): string[] {
  return [
    `server:${currentApiBase()}`,
    `session:${currentSessionGeneration()}`,
    `space:${spaceId ?? selectedSpaceId() ?? ""}`,
  ];
}

/**
 * One rpc read in the current scope. Its answer is only cached under the scope it was sent in.
 * A `spaceId` sends it to that Space instead of the selected one.
 */
export function rpcQuery<P extends RpcPath>(proc: P, input?: RpcInput<P>, spaceId?: string) {
  type T = RpcOutput<P>;
  const scope = scopeKey(spaceId);
  const queryKey = [...scope, proc, input ?? {}] as unknown as DataTag<QueryKey, T, Error>;
  const queryFn: QueryFunction<T> = async ({ signal }) => {
    if (scopeKey(spaceId).join("\n") !== scope.join("\n"))
      throw new Error(t("Something went wrong. Try again."));
    const requestContext = await captureApiRequestContext(spaceId);
    const answer = await rpc(proc, ...([input, { signal, requestContext }] as RpcArgs<P>));
    if (scopeKey(spaceId).join("\n") !== scope.join("\n"))
      throw new Error(t("Something went wrong. Try again."));
    return answer;
  };
  return { queryKey, queryFn };
}

/** Forgets every cached read; the session registers this so sign-out never shows old data. */
export function clearQueries(): void {
  queryClient.clear();
}
