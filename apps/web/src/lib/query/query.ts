import type { RouterUtils } from "@orpc/tanstack-query";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppBootstrap } from "@rakazo/contracts";
import { isRetryableError, retryDelayMs } from "@rakazo/core";
import type { DataTag, QueryKey } from "@tanstack/react-query";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { RpcClient } from "./rpc";
import { createSpaceRpc, rpcForSpace, selectedSpaceId } from "./rpc";
import { useBoundSpaceId } from "./space-rpc";

/**
 * Screens paint what they last saw and refresh it in the background, so moving between
 * spaces, chats, and settings sections does not wait on the network again.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 30 * 60_000,
      // Screens refresh every time they open, even over a recent read; live updates and
      // polling keep open ones current.
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
      retry: (failures, error) => failures < 1 && isRetryableError(error),
      retryDelay: (_failures, error) => retryDelayMs(error, 1_000),
    },
  },
});

export type SpaceQueries = RouterUtils<RpcClient>;

function scopePath(userId: string | null, spaceId: string | null): string[] {
  return [`user:${userId ?? ""}`, `space:${spaceId ?? ""}`];
}

const scopes = new Map<string, SpaceQueries>();

/**
 * Query helpers for one signed-in user in one space. Both are in every key, so cached data never
 * crosses an auth boundary, and each scope's client pins its own space header.
 */
export function spaceQueries(userId: string | null, spaceId: string | null): SpaceQueries {
  const path = scopePath(userId, spaceId);
  const id = path.join("\n");
  let scope = scopes.get(id);
  if (!scope) {
    scope = createTanstackQueryUtils(spaceId ? rpcForSpace(spaceId) : createSpaceRpc(null), {
      path,
    });
    scopes.set(id, scope);
  }
  return scope;
}

/**
 * Where a space's last bootstrap is kept. It holds the whole space (bots, groups, account), so
 * it is not keyed by bot: a visited space opens at once through any of its chats.
 */
export function spaceSeedKey(userId: string | null, spaceId: string | null) {
  return spaceQueries(userId, spaceId).bootstrap.queryKey({ input: {} });
}

export type ChatTarget =
  | { botId: string; groupId?: undefined }
  | { groupId: string; botId?: undefined };

/** Where a space keeps the chat it last had selected, apart from any snapshot that chat loaded. */
export function lastChatKey(userId: string | null, spaceId: string | null) {
  return [...spaceSeedKey(userId, spaceId), "last-chat"] as unknown as DataTag<
    QueryKey,
    ChatTarget
  >;
}

/** The chat a cached space had selected, if the space still lists it. */
export function lastChatOf(
  seed: AppBootstrap | undefined,
  chat: ChatTarget | undefined,
): ChatTarget | undefined {
  if (!seed || !chat) return undefined;
  if (chat.groupId) {
    return seed.groups.some((group) => group.id === chat.groupId) ? chat : undefined;
  }
  return seed.bots.some((bot) => bot.id === chat.botId) ? chat : undefined;
}

/**
 * What a space reopens with after the shell leaves it: its latest lists, and the loaded snapshot
 * only when it belongs to the selected chat. A chat picked just before leaving may still show the
 * previous chat's snapshot while its own loads.
 */
export function seedOnLeave(
  previous: AppBootstrap,
  latest: Omit<AppBootstrap, "thread" | "routines">,
  chat: ChatTarget | undefined,
  snapshot: AppBootstrap["thread"],
): AppBootstrap {
  const selected =
    snapshot &&
    chat &&
    (chat.groupId
      ? snapshot.groupId === chat.groupId
      : !snapshot.groupId && snapshot.botId === chat.botId);
  return { ...previous, ...latest, thread: selected ? snapshot : previous.thread };
}

const QueryUserContext = createContext<string | null>(null);

/** The signed-in user whose data the screens below may read from the cache. */
export const QueryUserProvider = QueryUserContext.Provider;

export function useQueryUserId(): string | null {
  return useContext(QueryUserContext);
}

/** Query helpers for the space these components act on: a bound settings space or the selected one. */
export function useSpaceQueries(): SpaceQueries {
  const userId = useQueryUserId();
  const boundSpaceId = useBoundSpaceId();
  const spaceId = boundSpaceId === undefined ? selectedSpaceId() : boundSpaceId;
  return spaceQueries(userId, spaceId);
}

/**
 * One save and the reads it makes out of date, under the contract of the mobile hook of the same
 * name. Only the save can fail it: once it succeeds those reads are marked stale and read again,
 * and a read that fails reports itself, never the save. `pending` is set by the same update as the
 * click and lasts until those reads are back, so a control never offers the old state in between.
 * `run` does nothing while a save is in flight, even for a second click in the same tick.
 * A save belongs to the user and space it was started for: the space these components are bound
 * to, or the one selected at the click. `save` writes through the client it receives, which names
 * that space whatever is selected by the time a request leaves. The save holds the controls and
 * reports for as long as the screen shows that user and space. Once the screen has gone or shows
 * another, a save that ends shows nothing and skips `onSaved` and `onFailed`; its request is never
 * cancelled.
 */
export function useSave<Input = void, Saved = unknown>(options: {
  save: (input: Input, rpc: RpcClient) => Promise<Saved>;
  /** The reads the save makes out of date, which may depend on what was saved. */
  stale?: readonly QueryKey[] | ((input: Input) => readonly QueryKey[]);
  onSaved?: (saved: Saved, input: Input) => unknown;
  /** For a toast or undoing an optimistic change; `error` is for showing the failure inline. */
  onFailed?: (error: Error, input: Input) => unknown;
  /** `onSaved` leaves the screen, so a success stays pending instead of offering the controls again. */
  closesScreen?: boolean;
}) {
  const queryClient = useQueryClient();
  const userId = useQueryUserId();
  const boundSpaceId = useBoundSpaceId();
  const scopeNow = () => {
    const spaceId = boundSpaceId === undefined ? selectedSpaceId() : boundSpaceId;
    return { spaceId, key: scopePath(userId, spaceId).join("\n") };
  };
  const [saves, setSaves] = useState<
    Record<string, { input: Input; pending: boolean; error: Error | null }>
  >({});
  // React state is a render behind; this is what a second call in the same tick is checked against.
  const inFlight = useRef(new Set<string>());
  // What the screen shows by the time a save ends, which can differ from what it was started for.
  const shownScope = useRef(scopeNow);
  shownScope.current = scopeNow;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = saves[scopeNow().key];
  return {
    run(input: Input) {
      const { spaceId, key } = scopeNow();
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      setSaves((now) => ({ ...now, [key]: { input, pending: true, error: null } }));
      const { save, stale = [], onSaved, onFailed, closesScreen } = options;
      const shown = () => mounted.current && shownScope.current().key === key;
      const finish = (error: Error | null) => {
        inFlight.current.delete(key);
        if (mounted.current)
          setSaves((now) => ({ ...now, [key]: { input, pending: false, error } }));
      };
      const rpc = spaceId ? rpcForSpace(spaceId) : createSpaceRpc(null);
      void (async () => save(input, rpc))().then(
        async (saved) => {
          const reads = typeof stale === "function" ? stale(input) : stale;
          await Promise.allSettled(
            reads.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
          );
          if (!closesScreen || !shown()) finish(null);
          if (!shown()) return;
          try {
            await onSaved?.(saved, input);
          } catch (error) {
            // The save went through; what failed came after it, such as leaving the screen. The
            // controls come back with the reason instead of staying held.
            finish(error as Error);
          }
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
    /** Forgets a failure, as when the draft it was about changes. */
    reset: () => {
      const { key } = scopeNow();
      setSaves((now) => {
        const { [key]: shown, ...rest } = now;
        return shown && !shown.pending ? rest : now;
      });
    },
  };
}

let cachedUserId: string | null | undefined;

/** Forgets everything cached for another user, so sign-out or a switch never shows their data. */
export function setQueryUser(userId: string | null): void {
  if (cachedUserId !== undefined && cachedUserId !== userId) queryClient.clear();
  cachedUserId = userId;
}
