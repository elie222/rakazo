import { useSyncExternalStore } from "react";
import { onConversationCleared } from "./conversation-cleared";

const THREAD_FAVORITES_KEY = "rakazo.thread-favorites";

export type ThreadFavorite = {
  messageId: string;
  /** The reply's first line or so, shown in the favorites list. */
  snippet: string;
  createdAt: number;
};

type FavoritesMap = Record<string, ThreadFavorite[]>;
const EMPTY: ThreadFavorite[] = [];
let favorites: FavoritesMap = {};
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
let clearingSubscribed = false;

function notify() {
  for (const listener of listeners) listener();
}

function isFavoriteItem(value: unknown): value is ThreadFavorite {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.messageId === "string" &&
    typeof item.snippet === "string" &&
    typeof item.createdAt === "number"
  );
}

async function loadFavorites(): Promise<void> {
  if (loaded) return;
  if (!loading) {
    loading = (async () => {
      try {
        // Deferred so importing this module never pulls the native store into tests.
        const SecureStore = await import("expo-secure-store");
        const stored = JSON.parse(
          (await SecureStore.getItemAsync(THREAD_FAVORITES_KEY)) ?? "null",
        ) as FavoritesMap | null;
        if (stored && typeof stored === "object") {
          for (const [key, list] of Object.entries(stored)) {
            if (Array.isArray(list)) favorites[key] = list.filter(isFavoriteItem);
          }
        }
      } catch {
        // Unreadable storage keeps every thread's favorites empty, the default.
      }
      loaded = true;
      notify();
    })();
  }
  await loading;
}

let saving: Promise<void> = Promise.resolve();

function persist() {
  const snapshot = JSON.stringify(favorites);
  saving = saving
    .then(async () => {
      const SecureStore = await import("expo-secure-store");
      await SecureStore.setItemAsync(THREAD_FAVORITES_KEY, snapshot);
    })
    .catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void loadFavorites();
  if (!clearingSubscribed) {
    clearingSubscribed = true;
    // A cleared conversation's favorites point at messages that no longer exist.
    onConversationCleared((botId) => {
      if (!favorites[botId]) return;
      favorites = { ...favorites };
      delete favorites[botId];
      notify();
      persist();
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

/** The first 64 characters of a reply, for the favorites list. */
export function favoriteSnippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 64 ? `${flat.slice(0, 64)}…` : flat;
}

/** This thread's favorites, newest first. */
export function threadFavoritesFor(threadKey: string | undefined): ThreadFavorite[] {
  if (!threadKey) return EMPTY;
  return favorites[threadKey] ?? EMPTY;
}

export function useThreadFavorites(threadKey: string | undefined): ThreadFavorite[] {
  useSyncExternalStore(subscribe, () => threadFavoritesFor(threadKey));
  return threadFavoritesFor(threadKey);
}

export function isThreadFavorite(threadKey: string, messageId: string): boolean {
  return (favorites[threadKey] ?? []).some((item) => item.messageId === messageId);
}

/**
 * Toggles a favorite; returns true when the message is now favorited. The list
 * stores the snippet at favorite time, so the sheet works even after the
 * message has scrolled out of the loaded window.
 */
export function toggleThreadFavorite(
  threadKey: string,
  favorite: ThreadFavorite,
): boolean {
  const list = favorites[threadKey] ?? [];
  const at = list.findIndex((item) => item.messageId === favorite.messageId);
  const next =
    at >= 0
      ? list.filter((item) => item.messageId !== favorite.messageId)
      : [{ ...favorite }, ...list];
  favorites = { ...favorites, [threadKey]: next };
  notify();
  persist();
  return at < 0;
}

export function removeThreadFavorite(threadKey: string, messageId: string): void {
  const list = favorites[threadKey];
  if (!list || !list.some((item) => item.messageId === messageId)) return;
  favorites = {
    ...favorites,
    [threadKey]: list.filter((item) => item.messageId !== messageId),
  };
  notify();
  persist();
}
