import type { DataTag, QueryFunction, QueryKey } from "@tanstack/react-query";
import { hashKey, isCancelledError, QueryClient } from "@tanstack/react-query";
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
export function rpcQuery<T>(proc: string, input?: object, spaceId?: string) {
  const scope = scopeKey(spaceId);
  const queryKey = [...scope, proc, input ?? {}] as unknown as DataTag<QueryKey, T, Error>;
  const queryFn: QueryFunction<T> = async ({ signal }) => {
    if (scopeKey(spaceId).join("\n") !== scope.join("\n"))
      throw new Error(t("Something went wrong. Try again."));
    const requestContext = await captureApiRequestContext(spaceId);
    const answer = await rpc<T>(proc, input, { signal, requestContext });
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

/**
 * Writes what a save confirmed. An older read still in flight is cancelled first, or it could
 * land afterwards and put the value from before the save back on screen.
 */
export async function writeSaved<T>(
  queryKey: DataTag<QueryKey, T, Error>,
  update: (current: T | undefined) => T,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData(queryKey, update);
}

/**
 * Reads data again. After a change, a read already in flight started before it, so that read is
 * cancelled rather than reused and the answer comes from a request sent afterwards. `reuse` is
 * for a screen opening, where sharing an in-flight read is fine.
 */
const freshAnswers = new Map<string, Promise<unknown>>();

export async function fetchFresh<T>(
  options: { queryKey: DataTag<QueryKey, T, Error>; queryFn: QueryFunction<T> },
  { reuse = false } = {},
): Promise<T> {
  if (reuse) return queryClient.fetchQuery({ ...options, staleTime: 0 });
  // Claimed before cancelling, so a refresh this one cancels can wait for its final answer.
  const key = hashKey(options.queryKey);
  let settle!: (answer: Promise<T>) => void;
  const answer = new Promise<T>((resolve) => {
    settle = resolve;
  });
  answer.catch(() => undefined);
  freshAnswers.set(key, answer);
  const run = (async () => {
    try {
      await queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
      return await queryClient.fetchQuery({ ...options, staleTime: 0 });
    } catch (error) {
      const newer = freshAnswers.get(key);
      // A newer refresh of the same data cancelled this one; its answer is newer still.
      if (isCancelledError(error) && newer && newer !== answer) return newer as Promise<T>;
      throw error;
    }
  })();
  settle(run);
  try {
    return await run;
  } finally {
    if (freshAnswers.get(key) === answer) freshAnswers.delete(key);
  }
}
