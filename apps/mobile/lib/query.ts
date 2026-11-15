import { t } from "@lingui/core/macro";
import type { RpcInput, RpcOutput, RpcPath } from "@rakazo/contracts";
import type { DataTag, QueryFunction, QueryKey } from "@tanstack/react-query";
import { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
 * One rpc write, for `useSave` to send: a screen names the procedure and never calls it. A
 * `spaceId` sends it to that Space instead of the selected one, as `rpcQuery` does for a read.
 */
export function rpcSave<P extends RpcPath>(proc: P, spaceId?: string) {
  return async (input: RpcInput<P>): Promise<RpcOutput<P>> => {
    if (!spaceId) return rpc(proc, ...([input] as RpcArgs<P>));
    const requestContext = await captureApiRequestContext(spaceId);
    return rpc(proc, ...([input, { requestContext }] as RpcArgs<P>));
  };
}

/**
 * One save and the reads it makes out of date. Only the save can fail it: once it succeeds those
 * reads are marked stale and read again, and a read that fails reports itself, never the save.
 * `pending` is set by the same update as the tap and lasts until those reads are back, so a
 * control never offers the old state in between. `run` does nothing while a save is in flight,
 * even for a second tap in the same tick.
 * A save that ends after the screen has gone, or after the server, session or space changed,
 * shows nothing and skips `onSaved` and `onFailed`.
 */
export function useSave<Input = void, Saved = unknown>(options: {
  save: (input: Input) => Promise<Saved>;
  stale?: readonly QueryKey[];
  onSaved?: (saved: Saved, input: Input) => unknown;
  /** For an alert or undoing an optimistic change; `error` is for showing the failure inline. */
  onFailed?: (error: Error, input: Input) => unknown;
  /** `onSaved` leaves the screen, so a success stays pending instead of offering the controls again. */
  closesScreen?: boolean;
}) {
  type Sent = { input: Input; scope: string };
  const [state, setState] = useState<{ sent: Sent; pending: boolean; error: Error | null } | null>(
    null,
  );
  // React state is a render behind; this is what a second call in the same tick is checked against.
  const inFlight = useRef<Sent | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = state?.sent.scope === spaceScope().join("\n") ? state : null;
  return {
    run(input: Input) {
      const scope = spaceScope().join("\n");
      if (inFlight.current?.scope === scope) return;
      const sent = { input, scope };
      inFlight.current = sent;
      setState({ sent, pending: true, error: null });
      const { save, stale = [], onSaved, onFailed, closesScreen } = options;
      const shown = () => mounted.current && spaceScope().join("\n") === scope;
      const finish = (error: Error | null) => {
        if (inFlight.current === sent) inFlight.current = null;
        setState((now) => (now?.sent === sent ? { sent, pending: false, error } : now));
      };
      void (async () => {
        const saved = await save(input);
        await Promise.all(stale.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        return saved;
      })().then(
        (saved) => {
          if (!closesScreen || !shown()) finish(null);
          if (shown()) void onSaved?.(saved, input);
        },
        (error: Error) => {
          finish(error);
          if (shown()) void onFailed?.(error, input);
        },
      );
    },
    pending: current?.pending ?? false,
    /** What the pending or failed save was sent with. */
    input: current?.sent.input,
    error: current?.error ?? null,
    reset: () => setState((now) => (now?.pending ? now : null)),
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
