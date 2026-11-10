import type { LogoAvatarActivity } from "@rakazo/core";
import { useSyncExternalStore } from "react";
import type { ImageSourcePropType } from "react-native";

/** The expression packs a bot's avatar can use. "chief" is the default Q-style assistant. */
export type ExpressionPack = "chief" | "off";

export const EXPRESSION_PACK_KEY = "rakazo.expression-pack";

/** The six face slots of the chief pack, one per activity state. */
export const EXPRESSION_FACE_SLOTS = [
  "thinking",
  "searching",
  "working",
  "waiting",
  "done",
  "error",
] as const;
export type ExpressionFaceSlot = (typeof EXPRESSION_FACE_SLOTS)[number];

/** Where a face image came from: a local pick wins over a subscription. */
export type ExpressionFaceSource = "local" | "subscription";

export type ExpressionFaceOverride = {
  /** A local file URI for a replaced or subscribed face. */
  uri: string;
  source: ExpressionFaceSource;
  /** The picked file's name, or the pack name for a subscribed face. */
  name?: string;
};

export type ExpressionSubscription = {
  /** The manifest URL the pack was subscribed from. */
  url: string;
  /** The pack name from the manifest, if it has one. */
  name?: string;
  /** When the pack was last fetched, as a unix ms timestamp. */
  updatedAt: number;
};

/** Face files live under the app's documents, one folder per account. */
export const EXPRESSION_FACES_DIR = "expression-faces";

function expressionFacesKey(userId: string): string {
  return `rakazo.expression-faces.${userId}`;
}

function expressionSubscriptionsKey(userId: string): string {
  return `rakazo.expression-subscriptions.${userId}`;
}

/** Only http(s) URLs can be fetched as a pack manifest or a face image. */
export function isExpressionPackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** The six faces of the chief pack, one per activity state. */
const CHIEF_IMAGES: Record<string, ImageSourcePropType> = {
  thinking: require("../assets/avatar-expressions/thinking.png"),
  searching: require("../assets/avatar-expressions/searching.png"),
  working: require("../assets/avatar-expressions/working.png"),
  waiting: require("../assets/avatar-expressions/waiting.png"),
  done: require("../assets/avatar-expressions/done.png"),
  error: require("../assets/avatar-expressions/error.png"),
};

/** Which chief face slot an activity shows. Idle rests on the thinking face. */
export function expressionSlotForActivity(
  activity: LogoAvatarActivity,
  justFinished = false,
): ExpressionFaceSlot {
  if (justFinished) return "done";
  switch (activity) {
    case "reading":
      return "searching";
    case "writing":
    case "computer":
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "error":
      return "error";
    default:
      return "thinking";
  }
}

/** A face override's image, or the built-in face when the slot is untouched. */
export function expressionFaceImageFor(
  userId: string | undefined,
  botId: string | undefined,
  slot: ExpressionFaceSlot,
): ImageSourcePropType {
  const override = faceOverrideFor(userId, botId, slot);
  return override ? { uri: override.uri } : CHIEF_IMAGES[slot]!;
}

/** Which chief face an activity shows. Idle rests on the thinking face. */
export function expressionImageFor(
  activity: LogoAvatarActivity,
  justFinished = false,
  userId?: string,
  botId?: string,
): ImageSourcePropType {
  return expressionFaceImageFor(userId, botId, expressionSlotForActivity(activity, justFinished));
}

/** The chief pack's faces, each resolved to its effective image, for the avatar editor. */
export function chiefExpressionGallery(
  userId?: string,
  botId?: string,
): { id: ExpressionFaceSlot; image: ImageSourcePropType; customized: boolean }[] {
  return EXPRESSION_FACE_SLOTS.map((slot) => ({
    id: slot,
    image: expressionFaceImageFor(userId, botId, slot),
    customized: faceOverrideFor(userId, botId, slot) !== null,
  }));
}

type PackMap = Record<string, ExpressionPack>;
let packs: PackMap = {};
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

async function loadPacks(): Promise<void> {
  if (loaded) return;
  if (!loading) {
    loading = (async () => {
      try {
        // Deferred so importing this module never pulls the native store into tests.
        const SecureStore = await loadSecureStore();
        const stored = JSON.parse(
          (await SecureStore.getItemAsync(EXPRESSION_PACK_KEY)) ?? "null",
        ) as PackMap | null;
        if (stored && typeof stored === "object") packs = stored;
      } catch {
        // Unreadable storage keeps every bot on the default pack.
      }
      loaded = true;
      notify();
    })();
  }
  await loading;
}

let saving: Promise<void> = Promise.resolve();

/** Face overrides per account: user id → `${botId}:${face}` → override. */
type FacesByUser = Record<string, Record<string, ExpressionFaceOverride>>;
let facesByUser: FacesByUser = {};
/** Subscriptions per account: user id → bot id → subscription. */
type SubscriptionsByUser = Record<string, Record<string, ExpressionSubscription>>;
let subscriptionsByUser: SubscriptionsByUser = {};
const loadedFaceUsers = new Set<string>();
const loadingFaceUsers = new Map<string, Promise<void>>();
const faceListeners = new Set<() => void>();
/** Bumped on every face or subscription change; the gallery cache keys off it. */
let facesVersion = 0;
let galleryCacheKey = "";
let galleryCache: { id: ExpressionFaceSlot; image: ImageSourcePropType; customized: boolean }[] =
  [];

function notifyFaces() {
  facesVersion += 1;
  for (const listener of faceListeners) listener();
}

function faceKey(botId: string, face: ExpressionFaceSlot): string {
  return `${botId}:${face}`;
}

function isFaceOverride(value: unknown): value is ExpressionFaceOverride {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.uri === "string" && (item.source === "local" || item.source === "subscription")
  );
}

function isSubscription(value: unknown): value is ExpressionSubscription {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.url === "string" &&
    typeof item.updatedAt === "number" &&
    (item.name === undefined || typeof item.name === "string")
  );
}

async function loadFaces(userId: string): Promise<void> {
  if (!userId || loadedFaceUsers.has(userId)) return;
  if (!loadingFaceUsers.has(userId)) {
    loadingFaceUsers.set(
      userId,
      (async () => {
        try {
          // Deferred so importing this module never pulls the native store into tests.
          const SecureStore = await loadSecureStore();
          const [storedFaces, storedSubs] = await Promise.all([
            SecureStore.getItemAsync(expressionFacesKey(userId)),
            SecureStore.getItemAsync(expressionSubscriptionsKey(userId)),
          ]);
          const faces: Record<string, ExpressionFaceOverride> = {};
          try {
            const parsed: unknown = JSON.parse(storedFaces ?? "null");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              for (const [key, value] of Object.entries(parsed)) {
                if (isFaceOverride(value)) faces[key] = value;
              }
            }
          } catch {
            // Unreadable faces keep every bot on the built-in pack.
          }
          const subs: Record<string, ExpressionSubscription> = {};
          try {
            const parsed: unknown = JSON.parse(storedSubs ?? "null");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              for (const [key, value] of Object.entries(parsed)) {
                if (isSubscription(value)) subs[key] = value;
              }
            }
          } catch {
            // An unreadable subscription reads as no subscription.
          }
          facesByUser = { ...facesByUser, [userId]: faces };
          subscriptionsByUser = { ...subscriptionsByUser, [userId]: subs };
        } catch {
          // Unreadable storage keeps every bot on the built-in pack.
        }
        loadedFaceUsers.add(userId);
        notifyFaces();
      })(),
    );
  }
  await loadingFaceUsers.get(userId);
}

let faceSaving: Promise<void> = Promise.resolve();
let subscriptionSaving: Promise<void> = Promise.resolve();

function persistFaces(userId: string) {
  const snapshot = JSON.stringify(facesByUser[userId] ?? {});
  const key = expressionFacesKey(userId);
  faceSaving = faceSaving
    .then(async () => {
      const SecureStore = await loadSecureStore();
      await SecureStore.setItemAsync(key, snapshot);
    })
    .catch(() => undefined);
}

function persistSubscriptions(userId: string) {
  const snapshot = JSON.stringify(subscriptionsByUser[userId] ?? {});
  const key = expressionSubscriptionsKey(userId);
  subscriptionSaving = subscriptionSaving
    .then(async () => {
      const SecureStore = await loadSecureStore();
      await SecureStore.setItemAsync(key, snapshot);
    })
    .catch(() => undefined);
}

/**
 * The native store, loaded lazily once and shared: concurrent dynamic
 * imports of the same module can race the loader, so every caller awaits
 * the one promise instead of importing again.
 */
let secureStorePromise: Promise<typeof import("expo-secure-store")> | null = null;

function loadSecureStore(): Promise<typeof import("expo-secure-store")> {
  if (!secureStorePromise) {
    secureStorePromise = import("expo-secure-store").catch((error: unknown) => {
      secureStorePromise = null;
      throw error;
    });
  }
  return secureStorePromise;
}

let fileSystemPromise: Promise<typeof import("expo-file-system")> | null = null;

function loadFileSystem(): Promise<typeof import("expo-file-system")> {
  if (!fileSystemPromise) {
    fileSystemPromise = import("expo-file-system").catch((error: unknown) => {
      fileSystemPromise = null;
      throw error;
    });
  }
  return fileSystemPromise;
}

/** This bot's face override for a slot, or null for the built-in face. */
export function faceOverrideFor(
  userId: string | undefined,
  botId: string | undefined,
  face: ExpressionFaceSlot,
): ExpressionFaceOverride | null {
  if (!userId || !botId) return null;
  return facesByUser[userId]?.[faceKey(botId, face)] ?? null;
}

/** This bot's pack subscription, or null when it has none. */
export function expressionSubscriptionFor(
  userId: string | undefined,
  botId: string | undefined,
): ExpressionSubscription | null {
  if (!userId || !botId) return null;
  return subscriptionsByUser[userId]?.[botId] ?? null;
}

function galleryFor(
  userId: string | undefined,
  botId: string | undefined,
): { id: ExpressionFaceSlot; image: ImageSourcePropType; customized: boolean }[] {
  const key = `${userId ?? ""}:${botId ?? ""}:${facesVersion}`;
  if (key === galleryCacheKey) return galleryCache;
  galleryCache = chiefExpressionGallery(userId, botId);
  galleryCacheKey = key;
  return galleryCache;
}

/** The chief pack's faces, live: a replace or subscription re-renders the gallery. */
export function useExpressionFaces(
  userId: string | undefined,
  botId: string | undefined,
): { id: ExpressionFaceSlot; image: ImageSourcePropType; customized: boolean }[] {
  useSyncExternalStore(
    (listener) => {
      faceListeners.add(listener);
      if (userId) void loadFaces(userId);
      return () => {
        faceListeners.delete(listener);
      };
    },
    () => galleryFor(userId, botId),
  );
  return galleryFor(userId, botId);
}

/** This bot's pack subscription, live: subscribing or cancelling re-renders. */
export function useExpressionSubscription(
  userId: string | undefined,
  botId: string | undefined,
): ExpressionSubscription | null {
  useSyncExternalStore(
    (listener) => {
      faceListeners.add(listener);
      if (userId) void loadFaces(userId);
      return () => {
        faceListeners.delete(listener);
      };
    },
    () => expressionSubscriptionFor(userId, botId),
  );
  return expressionSubscriptionFor(userId, botId);
}

/** The pack a bot's avatar uses. Chief is the default; "off" keeps the regular avatar. */
export function expressionPackFor(botId: string | undefined): ExpressionPack {
  if (!botId) return "chief";
  return packs[botId] ?? "chief";
}

/** A copy of every bot's pack choice, for the settings backup file. */
export function allExpressionPacks(): Record<string, ExpressionPack> {
  return { ...packs };
}

export function useExpressionPack(botId: string | undefined): ExpressionPack {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      void loadPacks();
      return () => {
        listeners.delete(listener);
      };
    },
    () => expressionPackFor(botId),
  );
  return expressionPackFor(botId);
}

/** Switches a bot's expression pack; the change is local to this device. */
export function setExpressionPack(botId: string, pack: ExpressionPack): void {
  packs = { ...packs, [botId]: pack };
  notify();
  const value = JSON.stringify(packs);
  saving = saving
    .then(async () => {
      const SecureStore = await loadSecureStore();
      await SecureStore.setItemAsync(EXPRESSION_PACK_KEY, value);
    })
    .catch(() => undefined);
}

/** Sets one face's override; null restores the built-in face for that slot. */
export function setExpressionFace(
  userId: string,
  botId: string,
  face: ExpressionFaceSlot,
  value: ExpressionFaceOverride | null,
): void {
  const current = facesByUser[userId] ?? {};
  if (value) {
    facesByUser = { ...facesByUser, [userId]: { ...current, [faceKey(botId, face)]: value } };
  } else {
    const next = { ...current };
    delete next[faceKey(botId, face)];
    facesByUser = { ...facesByUser, [userId]: next };
  }
  notifyFaces();
  persistFaces(userId);
}

/** Records or clears a bot's pack subscription; null cancels it. */
export function setExpressionSubscription(
  userId: string,
  botId: string,
  value: ExpressionSubscription | null,
): void {
  const current = subscriptionsByUser[userId] ?? {};
  if (value) {
    subscriptionsByUser = { ...subscriptionsByUser, [userId]: { ...current, [botId]: value } };
  } else {
    const next = { ...current };
    delete next[botId];
    subscriptionsByUser = { ...subscriptionsByUser, [userId]: next };
  }
  notifyFaces();
  persistSubscriptions(userId);
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_") || "x";
}

function expressionFileName(
  botId: string,
  face: ExpressionFaceSlot,
  source: ExpressionFaceSource,
  name: string,
): string {
  const match = /\.([A-Za-z0-9]{2,5})$/.exec(name.trim());
  const ext = match?.[1] ? `.${match[1].toLowerCase()}` : ".png";
  return `${safeSegment(botId)}-${face}-${source}${ext}`;
}

async function expressionFaceDirectory(userId: string) {
  const { Directory, Paths } = await loadFileSystem();
  const root = new Directory(Paths.document, EXPRESSION_FACES_DIR);
  if (!root.exists) root.create();
  const directory = new Directory(root, safeSegment(userId));
  if (!directory.exists) directory.create();
  return directory;
}

/**
 * Copies a picked image into the app's documents, so the face survives the
 * picker's temporary URI going away. Replaces this slot's previous file of
 * the same source, and removes the old file when its name differs.
 */
export async function saveExpressionFaceFile(
  userId: string,
  botId: string,
  face: ExpressionFaceSlot,
  sourceUri: string,
  name: string,
  source: ExpressionFaceSource,
): Promise<{ uri: string; name: string }> {
  const { File } = await loadFileSystem();
  const directory = await expressionFaceDirectory(userId);
  const fileName = expressionFileName(botId, face, source, name);
  const target = new File(directory, fileName);
  const previous = faceOverrideFor(userId, botId, face);
  await new File(sourceUri).copy(target);
  if (
    previous &&
    previous.source === source &&
    previous.uri !== target.uri &&
    previous.uri.startsWith(directory.uri)
  ) {
    try {
      new File(previous.uri).delete();
    } catch {
      // A leftover file is harmless; the new face already points at its copy.
    }
  }
  return { uri: target.uri, name };
}

/** Best-effort removal of a face file this bot no longer uses. */
export async function deleteExpressionFaceFile(uri: string): Promise<void> {
  try {
    const { Directory, File, Paths } = await loadFileSystem();
    const directory = new Directory(Paths.document, EXPRESSION_FACES_DIR);
    if (!uri.startsWith(directory.uri)) return;
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // The file is either gone or unreadable; either way there is nothing to show.
  }
}

/** Restores one face to the built-in image and removes its custom file. */
export function restoreExpressionFace(
  userId: string,
  botId: string,
  face: ExpressionFaceSlot,
): void {
  const current = faceOverrideFor(userId, botId, face);
  if (!current) return;
  setExpressionFace(userId, botId, face, null);
  void deleteExpressionFaceFile(current.uri);
}

export type ExpressionPackManifest = {
  /** The pack name, if the manifest has one. */
  name?: string;
  /** One http(s) image URL per face slot; all six are required. */
  faces: Record<ExpressionFaceSlot, string>;
};

/** A parsed pack manifest, or null when the shape is wrong or a face is missing. */
export function parseExpressionPackManifest(value: unknown): ExpressionPackManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const faces = item.faces;
  if (!faces || typeof faces !== "object" || Array.isArray(faces)) return null;
  const parsed: Partial<Record<ExpressionFaceSlot, string>> = {};
  for (const slot of EXPRESSION_FACE_SLOTS) {
    const url = (faces as Record<string, unknown>)[slot];
    if (typeof url !== "string" || !isExpressionPackUrl(url)) return null;
    parsed[slot] = url;
  }
  const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : undefined;
  return { name, faces: parsed as Record<ExpressionFaceSlot, string> };
}

/**
 * Downloads one subscribed face to a temporary file, then moves it over the
 * slot file. A failed download leaves any previous face for the slot untouched.
 */
async function downloadExpressionFaceFile(
  userId: string,
  botId: string,
  face: ExpressionFaceSlot,
  url: string,
): Promise<{ uri: string }> {
  const { File } = await loadFileSystem();
  const directory = await expressionFaceDirectory(userId);
  const fileName = expressionFileName(botId, face, "subscription", url.split("?")[0] ?? url);
  const target = new File(directory, fileName);
  const temp = new File(directory, `${fileName}.tmp`);
  if (temp.exists) temp.delete();
  const task = File.createDownloadTask(url, temp);
  let downloaded: { uri: string } | null;
  try {
    downloaded = await task.downloadAsync();
  } finally {
    task.release();
  }
  if (!downloaded || !new File(downloaded.uri).exists) throw new Error("download failed");
  await new File(downloaded.uri).copy(target);
  try {
    new File(downloaded.uri).delete();
  } catch {
    // A leftover temp file is harmless; the slot already points at its copy.
  }
  return { uri: target.uri };
}

export type SubscribeExpressionPackResult =
  | { status: "ok"; name?: string }
  | { status: "error"; reason: "unreachable" | "invalid" };

/**
 * Fetches a pack manifest and downloads its six faces. A local pick on a
 * slot is never overwritten by a subscription; a slot the user restored to
 * built-in stays built-in on refresh, which only re-downloads slots that
 * are currently subscription-sourced.
 */
async function applyExpressionSubscription(
  userId: string,
  botId: string,
  url: string,
  onlySubscribed: boolean,
): Promise<SubscribeExpressionPackResult> {
  const trimmed = url.trim();
  if (!isExpressionPackUrl(trimmed)) return { status: "error", reason: "invalid" };
  let manifest: ExpressionPackManifest | null;
  try {
    const response = await fetch(trimmed);
    if (!response.ok) return { status: "error", reason: "unreachable" };
    manifest = parseExpressionPackManifest(await response.json());
  } catch {
    return { status: "error", reason: "unreachable" };
  }
  if (!manifest) return { status: "error", reason: "invalid" };
  // Download everything first: a half-applied pack with no record cannot refresh.
  const downloaded: Partial<Record<ExpressionFaceSlot, string>> = {};
  try {
    for (const slot of EXPRESSION_FACE_SLOTS) {
      const current = faceOverrideFor(userId, botId, slot);
      if (current?.source === "local") continue;
      if (onlySubscribed && current?.source !== "subscription") continue;
      downloaded[slot] = (
        await downloadExpressionFaceFile(userId, botId, slot, manifest.faces[slot])
      ).uri;
    }
  } catch {
    for (const uri of Object.values(downloaded)) {
      void deleteExpressionFaceFile(uri);
    }
    return { status: "error", reason: "unreachable" };
  }
  for (const [slot, uri] of Object.entries(downloaded)) {
    setExpressionFace(userId, botId, slot as ExpressionFaceSlot, {
      uri,
      source: "subscription",
      name: manifest.name,
    });
  }
  setExpressionSubscription(userId, botId, {
    url: trimmed,
    name: manifest.name,
    updatedAt: Date.now(),
  });
  return { status: "ok", name: manifest.name };
}

/** Subscribes a bot to a remote face pack, downloading its six faces. */
export async function subscribeExpressionPack(
  userId: string,
  botId: string,
  url: string,
): Promise<SubscribeExpressionPackResult> {
  return applyExpressionSubscription(userId, botId, url, false);
}

/** Re-fetches a bot's subscribed pack, refreshing its subscription-sourced faces. */
export async function refreshExpressionSubscription(
  userId: string,
  botId: string,
): Promise<SubscribeExpressionPackResult> {
  const subscription = expressionSubscriptionFor(userId, botId);
  if (!subscription) return { status: "error", reason: "invalid" };
  return applyExpressionSubscription(userId, botId, subscription.url, true);
}

/**
 * Cancels a bot's pack subscription and removes its subscribed faces; a
 * local pick on any slot stays in place.
 */
export function unsubscribeExpressionPack(userId: string, botId: string): void {
  const current = facesByUser[userId] ?? {};
  const next = { ...current };
  for (const slot of EXPRESSION_FACE_SLOTS) {
    const override = next[faceKey(botId, slot)];
    if (override?.source === "subscription") {
      delete next[faceKey(botId, slot)];
      void deleteExpressionFaceFile(override.uri);
    }
  }
  facesByUser = { ...facesByUser, [userId]: next };
  notifyFaces();
  persistFaces(userId);
  setExpressionSubscription(userId, botId, null);
}

/**
 * Clears a signed-out account's faces and subscriptions; call on sign-out /
 * account switch. Face files live under that account's folder, so removing
 * them cannot touch another account's faces.
 */
export async function clearExpressionFacesForUser(userId: string): Promise<void> {
  const faces = facesByUser[userId] ?? {};
  const uris = Object.values(faces).map((face) => face.uri);
  facesByUser = { ...facesByUser, [userId]: {} };
  subscriptionsByUser = { ...subscriptionsByUser, [userId]: {} };
  loadedFaceUsers.delete(userId);
  loadingFaceUsers.delete(userId);
  notifyFaces();
  try {
    const SecureStore = await loadSecureStore();
    await SecureStore.deleteItemAsync(expressionFacesKey(userId));
    await SecureStore.deleteItemAsync(expressionSubscriptionsKey(userId));
  } catch {
    // A store that cannot clear still signs out; the record stays until the
    // next sign-in overwrites it for that account.
  }
  for (const uri of uris) {
    await deleteExpressionFaceFile(uri).catch(() => undefined);
  }
}
