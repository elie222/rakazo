import { useSyncExternalStore } from "react";

const CHAT_BACKGROUNDS_KEY = "rakazo.chat-backgrounds";
const CHAT_BACKGROUND_FILES = "chat-backgrounds";

/** The background's opacity when one is first set. */
export const CHAT_BACKGROUND_DEFAULT_OPACITY = 40;
export const CHAT_BACKGROUND_MIN_OPACITY = 5;
export const CHAT_BACKGROUND_MAX_OPACITY = 100;

export type ChatBackgroundKind = "image" | "url" | "video";

export type ChatBackground = {
  kind: ChatBackgroundKind;
  /** A local file URI for an imported image or video, an http(s) URL for a subscription. */
  uri: string;
  /** The picked file's name, shown in settings. */
  name?: string;
  /** The background's opacity, 5–100. */
  opacity: number;
};

type BackgroundMap = Record<string, ChatBackground>;
let backgrounds: BackgroundMap = {};
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function isBackground(value: unknown): value is ChatBackground {
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
          (await SecureStore.getItemAsync(CHAT_BACKGROUNDS_KEY)) ?? "null",
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
        // Unreadable storage keeps every chat on the default background.
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
      await SecureStore.setItemAsync(CHAT_BACKGROUNDS_KEY, snapshot);
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

/** Clamps an opacity to the slider's range, 5–100; garbage falls back to the default. */
export function clampChatBackgroundOpacity(value: number): number {
  if (!Number.isFinite(value)) return CHAT_BACKGROUND_DEFAULT_OPACITY;
  return Math.min(
    CHAT_BACKGROUND_MAX_OPACITY,
    Math.max(CHAT_BACKGROUND_MIN_OPACITY, Math.round(value)),
  );
}

/** A slider position (0–1 across the track) as an opacity, 5–100. */
export function chatBackgroundOpacityFromRatio(ratio: number): number {
  const clamped = Math.min(1, Math.max(0, ratio));
  return clampChatBackgroundOpacity(
    CHAT_BACKGROUND_MIN_OPACITY +
      clamped * (CHAT_BACKGROUND_MAX_OPACITY - CHAT_BACKGROUND_MIN_OPACITY),
  );
}

/** Only http(s) URLs can be subscribed as a background. */
export function isChatBackgroundUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** This thread's background, or null for the default. */
export function chatBackgroundFor(threadKey: string | undefined): ChatBackground | null {
  if (!threadKey) return null;
  return backgrounds[threadKey] ?? null;
}

export function useChatBackground(threadKey: string | undefined): ChatBackground | null {
  useSyncExternalStore(subscribe, () => chatBackgroundFor(threadKey));
  return chatBackgroundFor(threadKey);
}

/** Sets a thread's background; null restores the default. */
export function setChatBackground(threadKey: string, background: ChatBackground | null): void {
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

/** Adjusts a set background's opacity in place; a no-op without a background. */
export function setChatBackgroundOpacity(threadKey: string, opacity: number): void {
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
 * Copies a picked image or video into the app's documents, so the background
 * survives the picker's temporary URI going away. Replaces this thread's
 * previous file of the same kind, and removes the old file when its name differs.
 */
export async function saveChatBackgroundFile(
  threadKey: string,
  sourceUri: string,
  name: string,
  kind: "image" | "video",
): Promise<{ uri: string; name: string }> {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, CHAT_BACKGROUND_FILES);
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

/** Best-effort removal of a background file this thread no longer uses. */
export async function deleteChatBackgroundFile(uri: string): Promise<void> {
  try {
    const { Directory, File, Paths } = await import("expo-file-system");
    const directory = new Directory(Paths.document, CHAT_BACKGROUND_FILES);
    if (!uri.startsWith(directory.uri)) return;
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // The file is either gone or unreadable; either way there is nothing to show.
  }
}
