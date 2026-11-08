import { BOT_PACKAGE_MAX_BYTES } from "@rakazo/contracts";
import * as DocumentPicker from "expo-document-picker";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

export type BotPackageFileErrorCode =
  | "scope_changed"
  | "too_large"
  | "invalid_utf8"
  | "read_failed"
  | "sharing_unavailable"
  | "share_failed"
  | "cleanup_failed"
  | "cache_full";

export class BotPackageFileError extends Error {
  constructor(readonly code: BotPackageFileErrorCode) {
    super(code);
    this.name = "BotPackageFileError";
  }
}

function assertCurrent(isCurrent: () => boolean) {
  if (!isCurrent()) throw new BotPackageFileError("scope_changed");
}

function checkSize(bytes: number | undefined) {
  if (typeof bytes === "number" && bytes > BOT_PACKAGE_MAX_BYTES)
    throw new BotPackageFileError("too_large");
}

/** A missing or stale size cannot cause an unbounded whole-file read. */
async function readPackage(file: File): Promise<string> {
  const handle = file.open(FileMode.ReadOnly);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = handle.readBytes(Math.min(64 * 1024, BOT_PACKAGE_MAX_BYTES + 1 - size));
      if (!chunk.byteLength) break;
      size += chunk.byteLength;
      checkSize(size);
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new BotPackageFileError("invalid_utf8");
    }
  } finally {
    handle.close();
  }
}

/** The picker selects local data only; package parsing and authorization stay on the server. */
export async function pickBotPackageFile(isCurrent: () => boolean): Promise<string | null> {
  assertCurrent(isCurrent);
  try {
    const result = await DocumentPicker.getDocumentAsync({
      multiple: false,
      copyToCacheDirectory: false,
      type: ["application/json", "text/plain"],
    });
    assertCurrent(isCurrent);
    if (result.canceled) return null;
    const asset = result.assets.length === 1 ? result.assets[0] : null;
    if (!asset || !/^(?:file|content):\/\//.test(asset.uri))
      throw new BotPackageFileError("read_failed");
    checkSize(asset.size);
    const text = await readPackage(new File(asset.uri));
    assertCurrent(isCurrent);
    return text;
  } catch (error) {
    if (error instanceof BotPackageFileError) throw error;
    throw new BotPackageFileError("read_failed");
  }
}

export const BOT_PACKAGE_SHARE_TTL_MS = 24 * 60 * 60 * 1000;
export const BOT_PACKAGE_SHARE_MAX_FILES = 10;
export const BOT_PACKAGE_SHARE_MAX_BYTES = BOT_PACKAGE_SHARE_MAX_FILES * BOT_PACKAGE_MAX_BYTES;
const SHARE_ROOT = "bot-package-shares-v1";
const ENTRY_NAME = /^(\d{1,16})-[a-z0-9-]{8,100}$/i;
const activeShares = new Set<string>();
let reservationQueue: Promise<unknown> = Promise.resolve();
let fallbackNonce = 0;

type ShareFile = { directory: Directory; file: File; retention: File };

function shareRetainedAt(directory: Directory, fallback: number, now: number): number {
  const retention = new File(directory, "retention.json");
  if (!retention.exists) return fallback;
  try {
    const size = retention.info().size;
    if (typeof size !== "number" || size > 512) return now;
    const value: unknown = JSON.parse(retention.textSync());
    if (
      value &&
      typeof value === "object" &&
      "version" in value &&
      value.version === 1 &&
      "retainedAt" in value &&
      Number.isSafeInteger(value.retainedAt) &&
      typeof value.retainedAt === "number" &&
      value.retainedAt > 0
    )
      return value.retainedAt;
  } catch {
    // Unknown retention is counted as fresh rather than deleting a possibly active receiver's file.
  }
  return now;
}

function reserveShareFile(bytes: Uint8Array, isCurrent: () => boolean): Promise<ShareFile> {
  const reserve = () => {
    assertCurrent(isCurrent);
    const root = new Directory(Paths.cache, SHARE_ROOT);
    if (!root.exists) root.create();
    const now = Math.max(0, Date.now());
    let count = 0;
    let size = 0;
    for (const entry of root.list()) {
      if (!(entry instanceof Directory)) continue;
      const match = ENTRY_NAME.exec(entry.name);
      if (!match) continue;
      const retainedAt = shareRetainedAt(entry, Number(match[1]), now);
      if (!activeShares.has(entry.uri) && now - retainedAt >= BOT_PACKAGE_SHARE_TTL_MS) {
        entry.delete();
        continue;
      }
      count += 1;
      const knownSize = new File(entry, "package.json").info().size;
      size +=
        typeof knownSize === "number" && Number.isSafeInteger(knownSize) && knownSize >= 0
          ? knownSize
          : BOT_PACKAGE_MAX_BYTES;
    }
    if (
      count >= BOT_PACKAGE_SHARE_MAX_FILES ||
      size + bytes.byteLength > BOT_PACKAGE_SHARE_MAX_BYTES
    )
      throw new BotPackageFileError("cache_full");
    assertCurrent(isCurrent);
    const nonce =
      globalThis.crypto?.randomUUID?.() ??
      `${now.toString(36)}-${++fallbackNonce}-${Math.random().toString(36).slice(2).padEnd(8, "0")}`;
    const directory = new Directory(root, `${now}-${nonce}`);
    const file = new File(directory, "package.json");
    const retention = new File(directory, "retention.json");
    directory.create();
    try {
      file.create();
      file.write(bytes);
      retention.create();
      retention.write(JSON.stringify({ version: 1, retainedAt: now }));
    } catch (error) {
      try {
        directory.delete();
      } catch {
        throw new BotPackageFileError("cleanup_failed");
      }
      throw error;
    }
    activeShares.add(directory.uri);
    return { directory, file, retention };
  };
  const pending = reservationQueue.then(reserve, reserve);
  reservationQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

/** OS sharing does not prove the receiver read the file, so handed-off copies expire lazily. */
export async function shareBotPackageFile(text: string, isCurrent: () => boolean): Promise<void> {
  assertCurrent(isCurrent);
  const bytes = new TextEncoder().encode(text);
  checkSize(bytes.byteLength);
  if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== text)
    throw new BotPackageFileError("invalid_utf8");
  let available: boolean;
  try {
    available = await Sharing.isAvailableAsync();
  } catch {
    assertCurrent(isCurrent);
    throw new BotPackageFileError("share_failed");
  }
  assertCurrent(isCurrent);
  if (!available) throw new BotPackageFileError("sharing_unavailable");
  let owned: ShareFile | null = null;
  let shareInvoked = false;
  let failure: BotPackageFileError | null = null;
  try {
    owned = await reserveShareFile(bytes, isCurrent);
    assertCurrent(isCurrent);
    // Once invoked, even a rejected native promise cannot prove no receiver got the URI.
    shareInvoked = true;
    await Sharing.shareAsync(owned.file.uri, { mimeType: "application/json" });
    owned.retention.write(JSON.stringify({ version: 1, retainedAt: Math.max(0, Date.now()) }));
    assertCurrent(isCurrent);
  } catch (error) {
    failure =
      error instanceof BotPackageFileError ? error : new BotPackageFileError("share_failed");
  } finally {
    if (owned) {
      if (!shareInvoked) {
        try {
          owned.directory.delete();
        } catch {
          failure = new BotPackageFileError("cleanup_failed");
        }
      }
      activeShares.delete(owned.directory.uri);
    }
  }
  if (failure) throw failure;
}
