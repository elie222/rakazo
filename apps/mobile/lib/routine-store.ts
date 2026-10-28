import type { Routine } from "@rakazo/contracts";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import type { QueryFunction } from "@tanstack/react-query";
import { hashKey, useQuery } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { captureApiRequestContext, rpc } from "./api";
import { queryClient, rpcQuery } from "./query";
import { createQueuedSave } from "./queued-save";

/** A shown list asks again this often, so changes made elsewhere appear. */
export const ROUTINES_POLL_MS = 15_000;
/** A failed list read is tried once more after this long before it counts as failed. */
export const ROUTINES_RETRY_MS = 1_000;

type Toggle = ReturnType<typeof createQueuedSave<boolean>>;

// Keyed by the list's cache key (server, session, Space, bot), so nothing crosses a switch.
const writing = new Map<string, number>();
// Keyed by the list's cache key and the routine; a queue lives while it saves, so taps join it.
const toggles = new Map<string, Toggle>();
const saving = new Set<string>();
const toggleErrors = new Map<string, (error: unknown) => void>();
// Reads skipped while a save or delete ran, by cache key; they run once the last one ends.
const skippedReads = new Map<string, string>();

/** The bot's routines in the shared in-memory cache, with one more try when a read fails. */
function routinesQuery(botId: string) {
  const read = rpcQuery("routines/list", { botId });
  const queryFn: QueryFunction<Routine[]> = async (context) => {
    try {
      return await read.queryFn(context);
    } catch (error) {
      if (context.signal.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, ROUTINES_RETRY_MS));
      return read.queryFn(context);
    }
  };
  return { queryKey: read.queryKey, queryFn };
}

// Creation time never changes, so rows keep their place and new ones join at the end.
function oldestFirst(rows: Routine[]): Routine[] {
  return [...rows].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function countWrite(scope: string, change: 1 | -1) {
  const next = (writing.get(scope) ?? 0) + change;
  if (next > 0) {
    writing.set(scope, next);
    return;
  }
  writing.delete(scope);
  const botId = skippedReads.get(scope);
  skippedReads.delete(scope);
  // A screen that doesn't poll would otherwise keep what it showed before the save.
  if (botId !== undefined && hashKey(routinesQuery(botId).queryKey) === scope) {
    void loadBotRoutines(botId);
  }
}

/** Reads the bot's routines; a read already running is shared. */
export async function loadBotRoutines(botId: string): Promise<void> {
  const query = routinesQuery(botId);
  // A read sent during a save or delete could answer with the value from before it, so it
  // waits until they finish.
  const scope = hashKey(query.queryKey);
  if (writing.has(scope)) {
    skippedReads.set(scope, botId);
    return;
  }
  try {
    await fetchFresh(queryClient, query, { reuse: true });
  } catch {
    // The cache keeps the failure for the screens to show.
  }
}

/**
 * Pauses or resumes a routine. The switch moves at once; saves go one at a time and only the
 * latest tap is written. If that write fails, the routine goes back to its saved state.
 */
export function setRoutineActive(
  botId: string,
  routine: Routine,
  active: boolean,
  onError: (error: unknown) => void,
) {
  const { queryKey } = routinesQuery(botId);
  const scope = hashKey(queryKey);
  const id = `${scope}\n${routine.id}`;
  toggleErrors.set(id, onError);
  let toggle = saving.has(id) ? toggles.get(id) : undefined;
  if (!toggle) {
    // The server, account and space of the tap, not of whenever the save gets to run.
    const requestContext = captureApiRequestContext();
    requestContext.catch(() => undefined);
    const current = () => hashKey(routinesQuery(botId).queryKey) === scope;
    const patch = (change: (row: Routine) => Routine) =>
      writeSaved(queryClient, queryKey, (rows) =>
        (rows ?? []).map((row) => (row.id === routine.id ? change(row) : row)),
      );
    toggle = createQueuedSave(routine.active, {
      onChange: (value) => void patch((row) => ({ ...row, active: value })),
      save: async (value) => {
        const context = await requestContext;
        // Signed out or switched since the tap: that list is gone, so nothing is sent.
        if (!current()) return;
        const saved = await rpc(
          "routines/update",
          { routineId: routine.id, active: value },
          { requestContext: context },
        );
        // A newer tap may be waiting to save; the switch keeps showing it.
        await patch((row) => ({ ...row, ...saved, active: row.active }));
      },
      onSavingChange: (started) => {
        countWrite(scope, started ? 1 : -1);
        if (started) {
          saving.add(id);
          return;
        }
        // Nothing is waiting any more; the next tap starts a fresh queue from the shown value.
        saving.delete(id);
        toggles.delete(id);
        toggleErrors.delete(id);
      },
      onError: (error) => {
        if (current()) toggleErrors.get(id)?.(error);
      },
    });
    toggles.set(id, toggle);
  }
  toggle.update(active);
}

/** Deletes a routine; its row goes once the server confirms. */
export async function removeBotRoutine(botId: string, routineId: string): Promise<void> {
  const { queryKey } = routinesQuery(botId);
  const scope = hashKey(queryKey);
  // The server, account and space of the confirmation, as for a switch save.
  const requestContext = captureApiRequestContext();
  requestContext.catch(() => undefined);
  countWrite(scope, 1);
  try {
    await queryClient.cancelQueries({ queryKey, exact: true });
    const context = await requestContext;
    if (hashKey(routinesQuery(botId).queryKey) !== scope) return;
    await rpc("routines/remove", { routineId }, { requestContext: context });
    await writeSaved(queryClient, queryKey, (rows) =>
      (rows ?? []).filter((row) => row.id !== routineId),
    );
  } finally {
    countWrite(scope, -1);
  }
}

/**
 * The bot's routines, shared by every screen that shows them. Each time a screen comes into
 * view it shows what is already known and reads again, then keeps reading while it stays.
 */
export function useBotRoutines(botId: string, { poll = true }: { poll?: boolean } = {}) {
  const [shownSince] = useState(Date.now);
  const { data, error, dataUpdatedAt, errorUpdatedAt } = useQuery(
    { ...routinesQuery(botId), enabled: false, select: oldestFirst },
    queryClient,
  );
  useFocusEffect(
    useCallback(() => {
      if (!botId) return;
      void loadBotRoutines(botId);
      if (!poll) return;
      const timer = setInterval(() => void loadBotRoutines(botId), ROUTINES_POLL_MS);
      return () => clearInterval(timer);
    }, [botId, poll]),
  );
  return {
    routines: data,
    error,
    /** A read answered since this screen opened, so a missing routine is really gone. */
    readSinceShown: dataUpdatedAt >= shownSince,
    failedSinceShown: errorUpdatedAt >= shownSince && errorUpdatedAt > dataUpdatedAt,
  };
}
