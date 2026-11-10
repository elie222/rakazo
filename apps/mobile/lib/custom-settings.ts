import { useCallback, useSyncExternalStore } from "react";

/**
 * The interface's own tuning: hero background height per thread, the chips
 * row's width and card size, the three font slots (title / conversation /
 * error, each with its own size and colour, plus imported font files), the
 * message backgrounds (mine / AI / error), and the AI message action row's
 * order and hidden tiles. One object per account, so switching accounts never
 * shows another account's tuning.
 *
 * The shape mirrors the background settings: a module-level object per user
 * plus listeners, setX() updates memory and notifies at once (the screen
 * re-renders immediately, so a slider moves the interface live), and the
 * write to SecureStore happens in the background. The backup file carries
 * this object as its `custom` section; font files stay on this device and
 * only their names travel.
 */

export type CustomFontSlot = {
  size: number;
  /** Null follows the theme; a hex colour overrides it. */
  color: string | null;
};

export type ImportedCustomFont = {
  id: string;
  family: string;
  fileName: string;
  uri: string;
};

export type CustomFontSettings = {
  /** "system" or an imported font's family name. */
  family: string;
  title: CustomFontSlot;
  chat: CustomFontSlot;
  error: CustomFontSlot;
  imported: ImportedCustomFont[];
};

export type MessageActionId = "copy" | "speak" | "share" | "favorite" | "regenerate";

/** The three message surfaces' backgrounds; null follows the theme. */
export type CustomMessageBackgrounds = {
  user: string | null;
  ai: string | null;
  error: string | null;
};

export type CustomMessageActions = {
  order: MessageActionId[];
  hidden: MessageActionId[];
};

/** A patch for setCustomSettings: each section, and each font slot, is optional on its own. */
export type CustomSettingsPatch = {
  heroBackgroundHeights?: Record<string, number>;
  chipsRowWidthPct?: number;
  chipsCardWidth?: number;
  font?: Partial<Omit<CustomFontSettings, "title" | "chat" | "error">> & {
    title?: Partial<CustomFontSlot>;
    chat?: Partial<CustomFontSlot>;
    error?: Partial<CustomFontSlot>;
  };
  messageBackgrounds?: Partial<CustomMessageBackgrounds>;
  messageActions?: Partial<CustomMessageActions>;
};

export type CustomSettings = {
  /** Hero background height per thread, in percent of the hero height; absent means 100. */
  heroBackgroundHeights: Record<string, number>;
  chipsRowWidthPct: number;
  chipsCardWidth: number;
  font: CustomFontSettings;
  messageBackgrounds: CustomMessageBackgrounds;
  messageActions: CustomMessageActions;
};

export const CUSTOM_SETTINGS_KEY_PREFIX = "rakazo.custom-settings.";
export const CUSTOM_FONTS_DIR = "custom-fonts";

export const CUSTOM_SETTINGS_HERO_HEIGHT_MIN = 50;
export const CUSTOM_SETTINGS_HERO_HEIGHT_MAX = 150;
export const CUSTOM_SETTINGS_CHIPS_ROW_WIDTH_MIN = 60;
export const CUSTOM_SETTINGS_CHIPS_ROW_WIDTH_MAX = 100;
export const CUSTOM_SETTINGS_CHIPS_CARD_WIDTH_MIN = 56;
export const CUSTOM_SETTINGS_CHIPS_CARD_WIDTH_MAX = 96;
export const CUSTOM_SETTINGS_TITLE_SIZE_MIN = 14;
export const CUSTOM_SETTINGS_TITLE_SIZE_MAX = 24;
export const CUSTOM_SETTINGS_CHAT_SIZE_MIN = 14;
export const CUSTOM_SETTINGS_CHAT_SIZE_MAX = 22;
export const CUSTOM_SETTINGS_ERROR_SIZE_MIN = 12;
export const CUSTOM_SETTINGS_ERROR_SIZE_MAX = 18;
export const CUSTOM_SETTINGS_ERROR_COLOR_DEFAULT = "#e5484d";

export const DEFAULT_MESSAGE_ACTION_ORDER: MessageActionId[] = [
  "copy",
  "speak",
  "share",
  "favorite",
  "regenerate",
];

const MESSAGE_ACTION_IDS: MessageActionId[] = [...DEFAULT_MESSAGE_ACTION_ORDER];

export function customSettingsKey(userId: string): string {
  return `${CUSTOM_SETTINGS_KEY_PREFIX}${userId}`;
}

export function defaultCustomSettings(): CustomSettings {
  return {
    heroBackgroundHeights: {},
    chipsRowWidthPct: 100,
    chipsCardWidth: 72,
    font: {
      family: "system",
      title: { size: 17, color: null },
      chat: { size: 17, color: null },
      error: { size: 14, color: CUSTOM_SETTINGS_ERROR_COLOR_DEFAULT },
      imported: [],
    },
    messageBackgrounds: { user: null, ai: null, error: null },
    messageActions: { order: [...DEFAULT_MESSAGE_ACTION_ORDER], hidden: [] },
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampHexColor(value: unknown, fallback: string | null): string | null {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return fallback;
  return /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim().toLowerCase() : fallback;
}

function isMessageActionId(value: unknown): value is MessageActionId {
  return typeof value === "string" && (MESSAGE_ACTION_IDS as string[]).includes(value);
}

function parseFontSlot(
  value: unknown,
  fallback: CustomFontSlot,
  min: number,
  max: number,
): CustomFontSlot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const item = value as Record<string, unknown>;
  return {
    size: clampInt(item.size, min, max, fallback.size),
    color: clampHexColor(item.color, fallback.color),
  };
}

function parseImportedFonts(value: unknown): ImportedCustomFont[] {
  if (!Array.isArray(value)) return [];
  const out: ImportedCustomFont[] = [];
  for (const entry of value.slice(0, 50)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      item.id === "" ||
      typeof item.family !== "string" ||
      item.family === "" ||
      typeof item.fileName !== "string" ||
      item.fileName === "" ||
      typeof item.uri !== "string" ||
      item.uri === ""
    ) {
      continue;
    }
    out.push({ id: item.id, family: item.family, fileName: item.fileName, uri: item.uri });
  }
  return out;
}

/**
 * Parses a stored or restored settings object strictly: unknown fields are
 * dropped, out-of-range numbers are clamped, wrong types fall back to the
 * defaults, and a missing action id is appended back in its default place,
 * so a hand-edited or older file can never hide an action or crash a render.
 */
export function parseCustomSettings(value: unknown): CustomSettings {
  const fallback = defaultCustomSettings();
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const item = value as Record<string, unknown>;
  const heights: Record<string, number> = {};
  const rawHeights = item.heroBackgroundHeights;
  if (rawHeights && typeof rawHeights === "object" && !Array.isArray(rawHeights)) {
    for (const [key, height] of Object.entries(rawHeights).slice(0, 500)) {
      heights[key] = clampInt(
        height,
        CUSTOM_SETTINGS_HERO_HEIGHT_MIN,
        CUSTOM_SETTINGS_HERO_HEIGHT_MAX,
        100,
      );
    }
  }
  // A stored width map from 1.0.19 is dropped: a width cannot turn into a height.
  const rawBackgrounds =
    item.messageBackgrounds && typeof item.messageBackgrounds === "object"
      ? (item.messageBackgrounds as Record<string, unknown>)
      : {};
  const rawFont =
    item.font && typeof item.font === "object" ? (item.font as Record<string, unknown>) : {};
  const rawActions =
    item.messageActions && typeof item.messageActions === "object"
      ? (item.messageActions as Record<string, unknown>)
      : {};
  const order: MessageActionId[] = [];
  if (Array.isArray(rawActions.order)) {
    for (const id of rawActions.order) {
      if (isMessageActionId(id) && !order.includes(id)) order.push(id);
    }
  }
  for (const id of DEFAULT_MESSAGE_ACTION_ORDER) {
    if (!order.includes(id)) order.push(id);
  }
  const hidden: MessageActionId[] = [];
  if (Array.isArray(rawActions.hidden)) {
    for (const id of rawActions.hidden) {
      if (isMessageActionId(id) && !hidden.includes(id)) hidden.push(id);
    }
  }
  const family =
    typeof rawFont.family === "string" && rawFont.family !== "" ? rawFont.family : "system";
  const imported = parseImportedFonts(rawFont.imported);
  return {
    heroBackgroundHeights: heights,
    chipsRowWidthPct: clampInt(
      item.chipsRowWidthPct,
      CUSTOM_SETTINGS_CHIPS_ROW_WIDTH_MIN,
      CUSTOM_SETTINGS_CHIPS_ROW_WIDTH_MAX,
      100,
    ),
    chipsCardWidth: clampInt(
      item.chipsCardWidth,
      CUSTOM_SETTINGS_CHIPS_CARD_WIDTH_MIN,
      CUSTOM_SETTINGS_CHIPS_CARD_WIDTH_MAX,
      72,
    ),
    font: {
      family: imported.some((entry) => entry.family === family) ? family : "system",
      title: parseFontSlot(
        rawFont.title,
        fallback.font.title,
        CUSTOM_SETTINGS_TITLE_SIZE_MIN,
        CUSTOM_SETTINGS_TITLE_SIZE_MAX,
      ),
      chat: parseFontSlot(
        rawFont.chat,
        fallback.font.chat,
        CUSTOM_SETTINGS_CHAT_SIZE_MIN,
        CUSTOM_SETTINGS_CHAT_SIZE_MAX,
      ),
      error: parseFontSlot(
        rawFont.error,
        fallback.font.error,
        CUSTOM_SETTINGS_ERROR_SIZE_MIN,
        CUSTOM_SETTINGS_ERROR_SIZE_MAX,
      ),
      imported,
    },
    messageBackgrounds: {
      user: clampHexColor(rawBackgrounds.user, null),
      ai: clampHexColor(rawBackgrounds.ai, null),
      error: clampHexColor(rawBackgrounds.error, null),
    },
    messageActions: { order, hidden },
  };
}

/** A thread's hero background height, in percent of the hero height; 100 fills the hero. */
export function heroBackgroundHeightFor(
  settings: CustomSettings,
  threadKey: string | undefined,
): number {
  if (!threadKey) return 100;
  return settings.heroBackgroundHeights[threadKey] ?? 100;
}

/** A font size's line height at the body's 22/17 ratio, so a bigger size keeps its leading. */
export function scaledLineHeight(size: number): number {
  return Math.round((size * 22) / 17);
}

/** The resolved font family for text, or undefined to stay on the system font. */
export function customFontFamily(settings: CustomSettings): string | undefined {
  return settings.font.family === "system" ? undefined : settings.font.family;
}

type CustomTextStyle = {
  fontSize: number;
  lineHeight: number;
  color?: string;
  fontFamily?: string;
};

/** The title slot as a text style, to spread over a base title style. */
export function customTitleTextStyle(settings: CustomSettings): CustomTextStyle {
  const slot = settings.font.title;
  const family = customFontFamily(settings);
  return {
    fontSize: slot.size,
    lineHeight: scaledLineHeight(slot.size),
    ...(slot.color ? { color: slot.color } : {}),
    ...(family ? { fontFamily: family } : {}),
  };
}

/** The error slot as a text style, to spread over a base error style. */
export function customErrorTextStyle(settings: CustomSettings): CustomTextStyle {
  const slot = settings.font.error;
  const family = customFontFamily(settings);
  return {
    fontSize: slot.size,
    lineHeight: scaledLineHeight(slot.size),
    ...(slot.color ? { color: slot.color } : {}),
    ...(family ? { fontFamily: family } : {}),
  };
}

const FALLBACK = defaultCustomSettings();
const settingsByUser: Record<string, CustomSettings> = {};
const loadedUsers = new Set<string>();
const loadingUsers = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

async function loadCustomSettings(userId: string): Promise<void> {
  if (!userId || loadedUsers.has(userId)) return;
  if (!loadingUsers.has(userId)) {
    loadingUsers.set(
      userId,
      (async () => {
        try {
          // Deferred so importing this module never pulls the native store into tests.
          const SecureStore = await import("expo-secure-store");
          const stored = await SecureStore.getItemAsync(customSettingsKey(userId));
          if (stored) settingsByUser[userId] = parseCustomSettings(JSON.parse(stored));
        } catch {
          // Unreadable storage keeps the defaults.
        }
        loadedUsers.add(userId);
        notify();
        const settings = settingsByUser[userId];
        if (settings) void ensureCustomFontsLoaded(settings);
      })(),
    );
  }
  await loadingUsers.get(userId);
}

let saving: Promise<void> = Promise.resolve();

function persist(userId: string) {
  const snapshot = JSON.stringify(settingsByUser[userId] ?? defaultCustomSettings());
  saving = saving
    .then(async () => {
      const SecureStore = await import("expo-secure-store");
      await SecureStore.setItemAsync(customSettingsKey(userId), snapshot);
    })
    .catch(() => undefined);
}

/** This account's settings; the defaults until its stored settings load. */
export function customSettingsFor(userId: string): CustomSettings {
  if (!userId) return FALLBACK;
  return settingsByUser[userId] ?? FALLBACK;
}

/** The stored settings for this account, or null before they have loaded. */
export function loadedCustomSettings(userId: string): CustomSettings | null {
  if (!userId || !loadedUsers.has(userId)) return null;
  return settingsByUser[userId] ?? null;
}

export function useCustomSettings(userId: string): CustomSettings {
  const subscribe = useCallback(
    (listener: () => void) => {
      listeners.add(listener);
      if (userId) void loadCustomSettings(userId);
      return () => {
        listeners.delete(listener);
      };
    },
    [userId],
  );
  const getSnapshot = useCallback(() => customSettingsFor(userId), [userId]);
  // The server snapshot is the same read: before anything loads it is the
  // defaults, so a server-rendered message row (as the tests render one)
  // matches the client's first render instead of throwing.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Merges a patch into this account's settings; unknown fields and out-of-range values are dropped. */
export function setCustomSettings(userId: string, patch: CustomSettingsPatch): void {
  if (!userId) return;
  const current = customSettingsFor(userId);
  const fontPatch = patch.font;
  const backgroundsPatch = patch.messageBackgrounds;
  const next = parseCustomSettings({
    ...current,
    ...patch,
    font: fontPatch
      ? {
          ...current.font,
          ...fontPatch,
          title: { ...current.font.title, ...(fontPatch.title ?? {}) },
          chat: { ...current.font.chat, ...(fontPatch.chat ?? {}) },
          error: { ...current.font.error, ...(fontPatch.error ?? {}) },
        }
      : current.font,
    messageBackgrounds: backgroundsPatch
      ? { ...current.messageBackgrounds, ...backgroundsPatch }
      : current.messageBackgrounds,
    messageActions: patch.messageActions
      ? { ...current.messageActions, ...patch.messageActions }
      : current.messageActions,
  });
  settingsByUser[userId] = next;
  notify();
  persist(userId);
  void ensureCustomFontsLoaded(next);
}

/** Sets one thread's hero background height, in percent of the hero height. */
export function setHeroBackgroundHeight(userId: string, threadKey: string, height: number): void {
  if (!userId || !threadKey) return;
  const current = customSettingsFor(userId);
  setCustomSettings(userId, {
    heroBackgroundHeights: {
      ...current.heroBackgroundHeights,
      [threadKey]: clampInt(
        height,
        CUSTOM_SETTINGS_HERO_HEIGHT_MIN,
        CUSTOM_SETTINGS_HERO_HEIGHT_MAX,
        100,
      ),
    },
  });
}

/** Replaces this account's settings wholesale (backup restore); parses strictly first. */
export function applyCustomSettings(userId: string, value: unknown): CustomSettings {
  if (!userId) return FALLBACK;
  const next = parseCustomSettings(value);
  settingsByUser[userId] = next;
  loadedUsers.add(userId);
  notify();
  persist(userId);
  void ensureCustomFontsLoaded(next);
  return next;
}

const loadedFontFamilies = new Set<string>();
const loadingFontFamilies = new Map<string, Promise<boolean>>();

async function ensureImportedFontLoaded(entry: ImportedCustomFont): Promise<boolean> {
  if (loadedFontFamilies.has(entry.family)) return true;
  const existing = loadingFontFamilies.get(entry.family);
  if (existing) return existing;
  const task = (async () => {
    try {
      const Font = await import("expo-font");
      await Font.loadAsync({ [entry.family]: entry.uri });
      loadedFontFamilies.add(entry.family);
      notify();
      return true;
    } catch {
      return false;
    } finally {
      loadingFontFamilies.delete(entry.family);
    }
  })();
  loadingFontFamilies.set(entry.family, task);
  return task;
}

/** Loads every imported font in these settings, in the background. */
export function ensureCustomFontsLoaded(settings: CustomSettings): void {
  for (const entry of settings.font.imported) void ensureImportedFontLoaded(entry);
}

function fontFileName(family: string, ext: string): string {
  const safe =
    family
      .replace(/[^A-Za-z0-9 _-]/g, "_")
      .trim()
      .slice(0, 80) || "font";
  return `${safe}.${ext}`;
}

/**
 * Copies a picked .ttf/.otf into the app's documents and registers it as an
 * imported font, selected at once so the interface changes immediately.
 * Returns null for anything that is not a font file or could not be copied.
 */
export async function importCustomFont(
  userId: string,
  sourceUri: string,
  fileName: string,
): Promise<ImportedCustomFont | null> {
  if (!userId) return null;
  const match = /\.([A-Za-z0-9]{2,5})$/.exec(fileName.trim());
  const ext = match?.[1]?.toLowerCase();
  if (ext !== "ttf" && ext !== "otf") return null;
  const family = fileName.replace(/\.[A-Za-z0-9]{2,5}$/, "").trim() || "Custom Font";
  try {
    const { Directory, File, Paths } = await import("expo-file-system");
    const directory = new Directory(Paths.document, CUSTOM_FONTS_DIR);
    if (!directory.exists) directory.create();
    const target = new File(directory, fontFileName(family, ext));
    await new File(sourceUri).copy(target);
    const current = customSettingsFor(userId);
    const previous = current.font.imported.find((entry) => entry.family === family);
    if (previous && previous.uri !== target.uri && previous.uri.startsWith(directory.uri)) {
      try {
        new File(previous.uri).delete();
      } catch {
        // A leftover file is harmless; the new font already points at its copy.
      }
    }
    const entry: ImportedCustomFont = {
      id: previous?.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      family,
      fileName: target.name,
      uri: target.uri,
    };
    const imported = [...current.font.imported.filter((item) => item.family !== family), entry];
    setCustomSettings(userId, { font: { family, imported } });
    return entry;
  } catch {
    return null;
  }
}

/** Removes an imported font and its file; the active family falls back to the system font. */
export function removeImportedFont(userId: string, id: string): void {
  if (!userId) return;
  const current = customSettingsFor(userId);
  const entry = current.font.imported.find((item) => item.id === id);
  if (!entry) return;
  setCustomSettings(userId, {
    font: {
      family: current.font.family === entry.family ? "system" : current.font.family,
      imported: current.font.imported.filter((item) => item.id !== id),
    },
  });
  void (async () => {
    try {
      const { Directory, File, Paths } = await import("expo-file-system");
      const directory = new Directory(Paths.document, CUSTOM_FONTS_DIR);
      if (!entry.uri.startsWith(directory.uri)) return;
      const file = new File(entry.uri);
      if (file.exists) file.delete();
    } catch {
      // The file is either gone or unreadable; either way there is nothing to show.
    }
  })();
}

/** The actions that stay visible, in the user's order, for this message's capabilities. */
export function visibleMessageActions(
  settings: CustomSettings,
  capabilities: Partial<Record<MessageActionId, boolean>>,
): MessageActionId[] {
  return settings.messageActions.order.filter(
    (id) => !settings.messageActions.hidden.includes(id) && capabilities[id] !== false,
  );
}
