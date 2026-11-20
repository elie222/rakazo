import { parseServerHeaders } from "@rakazo/contracts";
import * as SecureStore from "expo-secure-store";
import { defaultApiBase, normalizeApiBase } from "./endpoint";

const SAVED_SERVERS_KEY = "rakazo.saved_servers";
export const MAX_SAVED_SERVERS = 5;

/** A server the device has used before, with the custom headers it was configured with. */
export type SavedServer = { apiBase: string; headers: Record<string, string> };

let saved: SavedServer[] = [];
/** False until the stored list has been read, and while it could not be: an unread list is not an empty one. */
let readable = false;
let writes: Promise<unknown> = Promise.resolve();

/** Servers used before, most recent first; empty until `loadSavedServers` has read the device. */
export function savedServers(): SavedServer[] {
  return saved;
}

/** Keeps only entries that can be switched to as they are: an exact normalized origin and valid headers. */
function parseSavedServers(stored: string | null): SavedServer[] {
  if (!stored) return [];
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch (error) {
    console.warn("Saved servers could not be parsed", error);
    return [];
  }
  if (!Array.isArray(value)) return [];
  const entries: SavedServer[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { apiBase, headers } = item as { apiBase?: unknown; headers?: unknown };
    if (typeof apiBase !== "string") continue;
    const normalized = normalizeApiBase(apiBase);
    const parsedHeaders = parseServerHeaders(headers);
    // A damaged entry is dropped, never switched to without the headers it needs.
    if (!normalized.ok || normalized.url !== apiBase || parsedHeaders === null) continue;
    if (apiBase === defaultApiBase() || entries.some((entry) => entry.apiBase === apiBase)) {
      continue;
    }
    entries.push({ apiBase, headers: parsedHeaders });
  }
  return entries.slice(0, MAX_SAVED_SERVERS);
}

async function readSavedServers(): Promise<void> {
  let stored: string | null = null;
  try {
    stored = await SecureStore.getItemAsync(SAVED_SERVERS_KEY);
    readable = true;
  } catch (error) {
    // SecureStore is unavailable in some test / web hosts. Nothing is listed, and nothing is
    // written over what could not be read.
    readable = false;
    console.warn("Saved servers could not be read", error);
  }
  saved = parseSavedServers(stored);
}

async function persist(next: SavedServer[]): Promise<boolean> {
  try {
    if (next.length === 0) await SecureStore.deleteItemAsync(SAVED_SERVERS_KEY);
    else await SecureStore.setItemAsync(SAVED_SERVERS_KEY, JSON.stringify(next));
    return true;
  } catch (error) {
    // The caller decides what a failed write means; this only reports it.
    console.warn("Saved servers could not be written", error);
    return false;
  }
}

/** Runs one task at a time, so a read never publishes a list older than a write that landed. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = writes.then(task);
  writes = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function loadSavedServers(): Promise<void> {
  return enqueue(readSavedServers);
}

/** Runs one change at a time against the latest list; the list only changes when the write lands. */
function change(update: (current: SavedServer[]) => SavedServer[]): Promise<boolean> {
  return enqueue(async () => {
    if (!readable) await readSavedServers();
    if (!readable) return false;
    const next = update(saved);
    if (!(await persist(next))) return false;
    saved = next;
    return true;
  });
}

/**
 * Remembers a server at the top of the list. The default server is never listed. `keepHeaders`
 * is for a server being left: its headers as the app read them may be missing, so a server
 * already listed keeps the headers it was saved with.
 */
export function recordSavedServer(
  apiBase: string,
  headers: Record<string, string>,
  options: { keepHeaders?: boolean } = {},
) {
  if (apiBase === defaultApiBase()) return Promise.resolve(false);
  return change((current) => {
    const existing = options.keepHeaders
      ? current.find((entry) => entry.apiBase === apiBase)
      : undefined;
    return [
      existing ?? { apiBase, headers },
      ...current.filter((entry) => entry.apiBase !== apiBase),
    ].slice(0, MAX_SAVED_SERVERS);
  });
}

/** Forgets one server and the headers kept for it. */
export function removeSavedServer(apiBase: string) {
  return change((current) => current.filter((entry) => entry.apiBase !== apiBase));
}
