import { allChatBackgrounds, CHAT_BACKGROUNDS_KEY, setChatBackground } from "./chat-background";
import type { CustomSettings } from "./custom-settings";
import {
  applyCustomSettings,
  customSettingsKey,
  loadedCustomSettings,
  parseCustomSettings,
} from "./custom-settings";
import { allExpressionPacks, EXPRESSION_PACK_KEY, setExpressionPack } from "./expression-avatar";
import { allHeroBackgrounds, HERO_BACKGROUNDS_KEY, setHeroBackground } from "./hero-background";
import type { BackupBackgroundValue, BackupSettingsFile } from "./webdav-backup";
import { buildBackupSettingsFile, parseBackupSettingsFile } from "./webdav-backup";

/**
 * The settings side of a WebDAV backup: hero backgrounds, chat backgrounds,
 * the expression pack, and the interface settings, as one small JSON file
 * next to the zip.
 *
 * Two limits to know about. The file carries metadata only: a local
 * image/video background is stored as kind/uri/opacity, and the picture file
 * itself is not in v1, so on another device that background points at a file
 * that is not there. And the file format has a single expressionPack value
 * while the app stores one pack per bot, so the backup keeps the pack most
 * bots use and restore applies it to the bots this device knows about.
 * Imported font files stay on this device too: only their names travel, so
 * a restored font selection waits for the file to be imported again.
 */

function isStoredBackground(value: unknown): value is BackupBackgroundValue {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    (item.kind === "image" || item.kind === "url" || item.kind === "video") &&
    typeof item.uri === "string" &&
    typeof item.opacity === "number"
  );
}

function storedBackgroundMap(raw: string | null): Record<string, BackupBackgroundValue> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, BackupBackgroundValue> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isStoredBackground(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** The settings file for this account, from SecureStore merged with memory. */
export async function readBackupSettingsFile(userId: string): Promise<BackupSettingsFile> {
  const SecureStore = await import("expo-secure-store");
  const [storedChat, storedHero, storedPacks, storedCustom] = await Promise.all([
    SecureStore.getItemAsync(CHAT_BACKGROUNDS_KEY),
    SecureStore.getItemAsync(HERO_BACKGROUNDS_KEY),
    SecureStore.getItemAsync(EXPRESSION_PACK_KEY),
    SecureStore.getItemAsync(customSettingsKey(userId)),
  ]);
  // Memory wins: it holds changes whose persist has not flushed yet.
  const chatBackgrounds = { ...storedBackgroundMap(storedChat), ...allChatBackgrounds() };
  const heroBackground = { ...storedBackgroundMap(storedHero), ...allHeroBackgrounds() };
  let custom: CustomSettings;
  try {
    custom = storedCustom
      ? parseCustomSettings(JSON.parse(storedCustom))
      : parseCustomSettings(undefined);
  } catch {
    custom = parseCustomSettings(undefined);
  }
  const loaded = loadedCustomSettings(userId);
  if (loaded) custom = loaded;
  let packs: Record<string, "chief" | "off"> = {};
  try {
    const parsed: unknown = JSON.parse(storedPacks ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (value === "chief" || value === "off") packs[key] = value;
      }
    }
  } catch {
    packs = {};
  }
  packs = { ...packs, ...allExpressionPacks() };
  const counts = { chief: 0, off: 0 };
  for (const pack of Object.values(packs)) counts[pack] += 1;
  // The interface settings travel as the `custom` snapshot. Font files stay
  // on this device; only their names travel inside the snapshot.
  return buildBackupSettingsFile({
    userId,
    heroBackground,
    chatBackgrounds,
    expressionPack: counts.off > counts.chief ? "off" : "chief",
    custom: custom as unknown as Record<string, unknown>,
  });
}

/**
 * Writes a settings file back into SecureStore through the same setters the
 * settings UI uses, so anything already on screen updates at once. Callers
 * pass the current thread's bot so the pack has somewhere to land when this
 * device has no pack entry yet. An old file's empty `custom` leaves the
 * interface settings alone; a file that carries them restores them.
 */
export function applyBackupSettingsFile(
  value: unknown,
  userId: string,
  currentBotId?: string,
): BackupSettingsFile {
  const file = parseBackupSettingsFile(value);
  if (!file) throw new Error("Invalid settings file");
  for (const [threadKey, background] of Object.entries(file.settings.chatBackgrounds)) {
    setChatBackground(threadKey, background);
  }
  if (file.settings.heroBackground) {
    for (const [threadKey, background] of Object.entries(file.settings.heroBackground)) {
      setHeroBackground(threadKey, background);
    }
  }
  const knownBots = new Set([
    ...Object.keys(allExpressionPacks()),
    ...(currentBotId ? [currentBotId] : []),
  ]);
  for (const botId of knownBots) setExpressionPack(botId, file.settings.expressionPack);
  if (Object.keys(file.settings.custom).length > 0) {
    applyCustomSettings(userId, file.settings.custom);
  }
  return file;
}
