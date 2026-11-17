import { t } from "@lingui/core/macro";
import type { RpcInput, RpcOutput, RpcPath } from "@rakazo/contracts";
import type { DataTag, QueryFunction, QueryKey } from "@tanstack/react-query";
import { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiRequestContext, RpcArgs } from "../api/api";
import { captureApiRequestContext, currentApiBase, rpc, selectedSpaceId } from "../api/api";
import { currentSessionGeneration } from "../api/session";
import type { SettingsTarget } from "./settings-target";

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

/**
 * The scope of a pinned request, read from what the request itself carries: the server it goes
 * to, the session it presents and the Space it names.
 */
function requestScope(context: ApiRequestContext, account: boolean): string {
  const session = [`server:${context.apiBase}`, `session:${context.sessionGeneration}`];
  const space = `space:${context.headers["x-rakazo-space-id"] ?? ""}`;
  return (account ? session : [...session, space]).join("\n");
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
 * One rpc read of what a settings screen edits: the named Space's copy, or the account's, which is
 * the same whichever Space is selected.
 */
export function targetRpcQuery<P extends RpcPath>(
  target: SettingsTarget,
  proc: P,
  input?: RpcInput<P>,
) {
  return target.scope === "space"
    ? rpcQuery(proc, input, target.spaceId)
    : accountRpcQuery(proc, input);
}

/**
 * The read behind a form, kept apart from every other reader of the same data: sent again each
 * time the screen opens and dropped when it leaves. A draft then starts from what is saved now,
 * never from an earlier visit's copy or one another screen cached.
 */
export function formRead<T>(read: {
  queryKey: DataTag<QueryKey, T, Error>;
  queryFn: QueryFunction<T>;
}) {
  return {
    queryKey: [...read.queryKey, "form"] as unknown as DataTag<QueryKey, T, Error>,
    queryFn: read.queryFn,
    gcTime: 0,
    refetchOnMount: "always" as const,
  };
}

/** One rpc write of a save. It is refused once the save's server, session or Space is no longer current. */
export type SaveSend = <P extends RpcPath>(proc: P, input: RpcInput<P>) => Promise<RpcOutput<P>>;

/** Writes with this request context, or with the current one when there is none. */
export function sendWith(requestContext: ApiRequestContext | undefined): SaveSend {
  return (proc, body) =>
    rpc(proc, ...([body, requestContext && { requestContext }] as RpcArgs<typeof proc>));
}

/**
 * One save and the reads it makes out of date. Only the save can fail it: once it succeeds those
 * reads are marked stale and read again, and a read that fails reports itself, never the save.
 * `pending` is set by the same update as the tap and lasts until those reads are back, so a
 * control never offers the old state in between. `run` does nothing while a save is in flight,
 * even for a second tap in the same tick.
 * A save belongs to the server, session and Space it was started for: the Space selected at the
 * tap, or the `target` the screen names. Its request context is pinned with the tap, and `send`
 * writes with that context and nothing else: the address, the credentials and the scope the save
 * is judged by are one thing, and a write is refused once they are no longer current. The save
 * holds the controls and reports for as long as the screen shows that scope, whatever is selected
 * meanwhile. Once the screen has gone or shows another server, session or Space, a save that ends
 * shows nothing and skips `onSaved` and `onFailed`.
 */
export function useSave<Input = void, Saved = unknown>(options: {
  save: (input: Input, send: SaveSend) => Promise<Saved>;
  /**
   * What the screen edits when it is not the selected Space: the Space its `rpcQuery` reads name,
   * or the account, as `accountRpcQuery` and `targetRpcQuery` read it.
   */
  target?: SettingsTarget;
  stale?: readonly QueryKey[];
  onSaved?: (saved: Saved, input: Input) => unknown;
  /** For an alert or undoing an optimistic change; `error` is for showing the failure inline. */
  onFailed?: (error: Error, input: Input) => unknown;
  /** `onSaved` leaves the screen, so a success stays pending instead of offering the controls again. */
  closesScreen?: boolean;
}) {
  const { target } = options;
  const account = target?.scope === "account";
  const namedSpace = target?.scope === "space" ? target.spaceId : undefined;
  const scopeKey = () => (account ? sessionScope() : spaceScope(namedSpace)).join("\n");
  const [saves, setSaves] = useState<
    Record<string, { input: Input; pending: boolean; error: Error | null }>
  >({});
  // React state is a render behind; this is what a second call in the same tick is checked against.
  const inFlight = useRef(new Set<string>());
  // What the screen shows by the time a save ends, which can differ from what it was started for.
  const shownScope = useRef(scopeKey);
  shownScope.current = scopeKey;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = saves[scopeKey()];
  /** Forgets a finished save's error for the scope shown; the same function on every render. */
  const reset = useCallback(() => {
    const scope = shownScope.current();
    setSaves((now) => {
      const { [scope]: shown, ...rest } = now;
      return shown && !shown.pending ? rest : now;
    });
  }, []);
  return {
    run(input: Input) {
      const scope = scopeKey();
      if (inFlight.current.has(scope)) return;
      inFlight.current.add(scope);
      setSaves((now) => ({ ...now, [scope]: { input, pending: true, error: null } }));
      const { save, stale = [], onSaved, onFailed, closesScreen } = options;
      const shown = () => mounted.current && shownScope.current() === scope;
      const finish = (error: Error | null) => {
        inFlight.current.delete(scope);
        setSaves((now) => ({ ...now, [scope]: { input, pending: false, error } }));
      };
      // Pinned in the tick `scope` was read in; an account save is sent with the Space selected now.
      const pinned = captureApiRequestContext(namedSpace).then(
        (requestContext) => ({ requestContext }),
        (failure: Error) => ({ failure }),
      );
      const send: SaveSend = async (proc, body) => {
        const pin = await pinned;
        if ("failure" in pin) throw pin.failure;
        const { requestContext } = pin;
        const sent = requestScope(requestContext, account);
        if (sent !== scope || sent !== scopeKey())
          throw new Error(t`Something went wrong. Try again.`);
        return sendWith(requestContext)(proc, body);
      };
      void (async () => {
        const saved = await save(input, send);
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
    input: current?.input,
    error: current?.error ?? null,
    reset,
  };
}

/** Forgets every cached read; the session registers this so sign-out never shows old data. */
export function clearQueries(): void {
  queryClient.clear();
}

/**
 * Forgets what one procedure answered, in every Space and for every input, once something outside
 * its readers has changed it. A screen showing it reads it again; the rest start from nothing.
 */
export function resetRpcQueries(proc: RpcPath): Promise<void> {
  return queryClient.resetQueries({ predicate: (query) => query.queryKey.includes(proc) });
}

/** Forgets the reads sent to these Spaces, as when leaving their organization. */
export function removeSpaceQueries(spaceIds: readonly string[]): void {
  const scopes = new Set(spaceIds.map((id) => `space:${id}`));
  queryClient.removeQueries({ predicate: (query) => scopes.has(String(query.queryKey[2])) });
}
