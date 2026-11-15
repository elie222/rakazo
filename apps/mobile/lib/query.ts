import { t } from "@lingui/core/macro";
import type { RpcInput, RpcOutput, RpcPath } from "@rakazo/contracts";
import type { DataTag, QueryFunction, QueryKey } from "@tanstack/react-query";
import { QueryClient, useMutation } from "@tanstack/react-query";
import type { RpcArgs } from "./api";
import { captureApiRequestContext, currentApiBase, rpc, selectedSpaceId } from "./api";
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
 * The server and signed-in session a read belongs to. A session change (sign-in, sign-out,
 * server switch) also clears the cache, so data never crosses an auth boundary.
 */
function sessionScope(): string[] {
  return [`server:${currentApiBase()}`, `session:${currentSessionGeneration()}`];
}

function spaceScope(spaceId?: string): string[] {
  return [...sessionScope(), `space:${spaceId ?? selectedSpaceId() ?? ""}`];
}

function scopedRpcQuery<P extends RpcPath>(
  scopeKey: () => string[],
  proc: P,
  input?: RpcInput<P>,
  spaceId?: string,
) {
  type T = RpcOutput<P>;
  const scope = scopeKey();
  const queryKey = [...scope, proc, input ?? {}] as unknown as DataTag<QueryKey, T, Error>;
  const queryFn: QueryFunction<T> = async ({ signal }) => {
    if (scopeKey().join("\n") !== scope.join("\n"))
      throw new Error(t`Something went wrong. Try again.`);
    const requestContext = await captureApiRequestContext(spaceId);
    const answer = await rpc(proc, ...([input, { signal, requestContext }] as RpcArgs<P>));
    if (scopeKey().join("\n") !== scope.join("\n"))
      throw new Error(t`Something went wrong. Try again.`);
    return answer;
  };
  return { queryKey, queryFn };
}

/**
 * One rpc read in the current scope (server, session, space). Its answer is only cached under
 * the scope it was sent in. A `spaceId` sends it to that Space instead of the selected one.
 */
export function rpcQuery<P extends RpcPath>(proc: P, input?: RpcInput<P>, spaceId?: string) {
  return scopedRpcQuery(() => spaceScope(spaceId), proc, input, spaceId);
}

/** One rpc read of the signed-in user's own data, the same in every space: cached once per session. */
export function accountRpcQuery<P extends RpcPath>(proc: P, input?: RpcInput<P>) {
  return scopedRpcQuery(sessionScope, proc, input);
}

/**
 * One save and the reads it makes out of date. Only the save can fail it: once it succeeds those
 * reads are marked stale and read again, and a read that fails reports itself, never the save.
 * `pending` lasts until they are back, so a control never offers the old state in between.
 * A save that ends after the screen has gone, or after the server, session or space changed,
 * shows nothing and skips `onSaved`.
 */
export function useSave<Input = void, Saved = unknown>(options: {
  save: (input: Input) => Promise<Saved>;
  stale?: readonly QueryKey[];
  onSaved?: (saved: Saved, input: Input) => unknown;
}) {
  const mutation = useMutation(
    {
      mutationFn: async ({ input }: { input: Input; scope: string }) => {
        const { save, stale = [] } = options;
        const saved = await save(input);
        await Promise.all(stale.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        return saved;
      },
    },
    queryClient,
  );
  const sent = mutation.variables;
  const current = sent?.scope === spaceScope().join("\n");
  return {
    run(input: Input) {
      const scope = spaceScope().join("\n");
      mutation.mutate(
        { input, scope },
        {
          onSuccess: (saved) => {
            if (spaceScope().join("\n") === scope) void options.onSaved?.(saved, input);
          },
        },
      );
    },
    pending: current && mutation.isPending,
    /** What the pending or failed save was sent with. */
    input: current ? sent.input : undefined,
    error: current ? mutation.error : null,
    reset: mutation.reset,
  };
}

/** Forgets every cached read; the session registers this so sign-out never shows old data. */
export function clearQueries(): void {
  queryClient.clear();
}

/** Forgets the reads sent to these Spaces, as when leaving their organization. */
export function removeSpaceQueries(spaceIds: readonly string[]): void {
  const scopes = new Set(spaceIds.map((id) => `space:${id}`));
  queryClient.removeQueries({ predicate: (query) => scopes.has(String(query.queryKey[2])) });
}
