import { useSyncExternalStore } from "react";
import type { ChatBackground } from "./chat-background";
import { clampChatBackgroundOpacity } from "./chat-background";

/**
 * The title hero's own background, independent of the chat background: the
 * same shape (a local image, a subscribed image URL, or a local video, plus
 * an opacity), stored per thread under its own key and in its own documents
 * folder, so setting one never touches the other. The hero keeps its solid
 * theme background underneath, and the opacity blends the picture over it —
 * the same transparency the chat background offers.
 */
export type HeroBackground = ChatBackground;

export const HERO_BACKGROUNDS_KEY = "rakazo.hero-backgrounds";
const HERO_BACKGROUND_FILES = "hero-backgrounds";

type BackgroundMap = Record<string, HeroBackground>;
let backgrounds: BackgroundMap = {};
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function isBackground(value: unknown): value is HeroBackground {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    (item.kind === "image" || item.kind === "url" || item.kind === "video") &&
    typeof item.uri === "string" &&
    typeof item.opacity === "number"
  );
}

async function loadBackgrounds(): Promise<void> {
  if (loaded) return;
  if (!loading) {
    loading = (async () => {
      try {
        // Deferred so importing this module never pulls the native store into tests.
        const SecureStore = await import("expo-secure-store");
        const stored = JSON.parse(
          (await SecureStore.getItemAsync(HERO_BACKGROUNDS_KEY)) ?? "null",
        ) as BackgroundMap | null;
        if (stored && typeof stored === "object") {
          for (const [key, value] of Object.entries(stored)) {
            if (isBackground(value)) {
              backgrounds[key] = {
                ...value,
                opacity: clampChatBackgroundOpacity(value.opacity),
              };
            }
          }
        }
      } catch {
        // Unreadable storage keeps every hero on the default background.
      }
      loaded = true;
      notify();
    })();
  }
  await loading;
}

let saving: Promise<void> = Promise.resolve();

function persist() {
  const snapshot = JSON.stringify(backgrounds);
  saving = saving
    .then(async () => {
      const SecureStore = await import("expo-secure-store");
      await SecureStore.setItemAsync(HERO_BACKGROUNDS_KEY, snapshot);
    })
    .catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void loadBackgrounds();
  return () => {
    listeners.delete(listener);
  };
}

/** This thread's hero background, or null for the default. */
export function heroBackgroundFor(threadKey: string | undefined): HeroBackground | null {
  if (!threadKey) return null;
  return backgrounds[threadKey] ?? null;
}

/** A copy of every thread's hero background, for the settings backup file. */
export function allHeroBackgrounds(): Record<string, HeroBackground> {
  return { ...backgrounds };
}

export function useHeroBackground(threadKey: string | undefined): HeroBackground | null {
  useSyncExternalStore(subscribe, () => heroBackgroundFor(threadKey));
  return heroBackgroundFor(threadKey);
}

/** Sets a thread's hero background; null restores the default. */
export function setHeroBackground(threadKey: string, background: HeroBackground | null): void {
  if (background) {
    backgrounds = {
      ...backgrounds,
      [threadKey]: { ...background, opacity: clampChatBackgroundOpacity(background.opacity) },
    };
  } else {
    backgrounds = { ...backgrounds };
    delete backgrounds[threadKey];
  }
  notify();
  persist();
}

/** Adjusts a set hero background's opacity in place; a no-op without a background. */
export function setHeroBackgroundOpacity(threadKey: string, opacity: number): void {
  const current = backgrounds[threadKey];
  if (!current) return;
  backgrounds = {
    ...backgrounds,
    [threadKey]: { ...current, opacity: clampChatBackgroundOpacity(opacity) },
  };
  notify();
  persist();
}

function backgroundFileName(threadKey: string, name: string, kind: "image" | "video"): string {
  const safeKey = threadKey.replace(/[^A-Za-z0-9_-]/g, "_");
  const match = /\.([A-Za-z0-9]{2,5})$/.exec(name.trim());
  const ext = match?.[1] ? `.${match[1].toLowerCase()}` : kind === "video" ? ".mp4" : ".jpg";
  return `${safeKey}-${kind}${ext}`;
}

/**
 * Copies a picked image or video into the app's documents, so the hero
 * background survives the picker's temporary URI going away. Replaces this
 * thread's previous file of the same kind, and removes the old file when its
 * name differs. Files live apart from the chat backgrounds', so the two
 * settings never share — or delete — each other's files.
 */
export async function saveHeroBackgroundFile(
  threadKey: string,
  sourceUri: string,
  name: string,
  kind: "image" | "video",
): Promise<{ uri: string; name: string }> {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, HERO_BACKGROUND_FILES);
  if (!directory.exists) directory.create();
  const fileName = backgroundFileName(threadKey, name, kind);
  const target = new File(directory, fileName);
  const previous = backgrounds[threadKey];
  await new File(sourceUri).copy(target);
  if (
    previous &&
    (previous.kind === "image" || previous.kind === "video") &&
    previous.uri !== target.uri &&
    previous.uri.startsWith(directory.uri)
  ) {
    try {
      new File(previous.uri).delete();
    } catch {
      // A leftover file is harmless; the new background already points at its copy.
    }
  }
  return { uri: target.uri, name };
}

/** Best-effort removal of a hero background file this thread no longer uses. */
export async function deleteHeroBackgroundFile(uri: string): Promise<void> {
  try {
    const { Directory, File, Paths } = await import("expo-file-system");
    const directory = new Directory(Paths.document, HERO_BACKGROUND_FILES);
    if (!uri.startsWith(directory.uri)) return;
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // The file is either gone or unreadable; either way there is nothing to show.
  }
}
