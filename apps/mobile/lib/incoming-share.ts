import { File, Paths } from "expo-file-system";
import type { SharePayload } from "expo-sharing";
import { clearSharedPayloads, getSharedPayloads } from "expo-sharing";
import { Platform } from "react-native";

export type IncomingShare = {
  text: string;
  files: Array<{ uri: string; name: string; mimeType: string | null }>;
  arrivedAt: number;
  generation: number;
};

const MAX_AGE_MS = 5 * 60 * 1000;
let generation = 0;
let copyId = 0;
let pending: IncomingShare | null = null;
let expiry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function publish(share: IncomingShare | null) {
  clearTimeout(expiry);
  pending = share;
  if (share)
    expiry = setTimeout(
      cancelIncomingShare,
      Math.max(0, share.arrivedAt + MAX_AGE_MS - Date.now()),
    );
  for (const listener of listeners) listener();
}

export function subscribeIncomingShare(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getIncomingShare() {
  return pending;
}

export function hasIncomingShare() {
  return pending !== null;
}

export function cancelIncomingShare() {
  if (Platform.OS !== "android") return;
  generation += 1;
  clearSharedPayloads();
  publish(null);
}

/** Called only by native-intent, so reopening without a share cannot revive old native data. */
export function receiveIncomingShare(isShare: boolean, initial: boolean) {
  if (Platform.OS !== "android") return;
  if (!isShare) {
    if (initial) cancelIncomingShare();
    return;
  }
  const payloads = getSharedPayloads();
  const isText = (payload: SharePayload) => ["text", "url"].includes(payload.shareType);
  const share: IncomingShare = {
    text: payloads
      .filter(isText)
      .map((payload) => payload.value.trim())
      .filter(Boolean)
      .join("\n"),
    files: payloads
      .filter((payload) => !isText(payload))
      .map((payload) => {
        let name = "file";
        try {
          name = new File(payload.value).name || name;
        } catch {
          // A broken provider URI must still reach the per-file import error path.
        }
        return { uri: payload.value, name, mimeType: payload.mimeType ?? null };
      }),
    arrivedAt: Date.now(),
    generation: ++generation,
  };
  publish(share.text || share.files.length ? share : null);
}

/** Claim synchronously: a second chat/effect cannot take the same share. */
export function takeIncomingShare(): IncomingShare | null {
  if (Platform.OS !== "android") return null;
  const share = pending;
  clearSharedPayloads();
  publish(null);
  return share && Date.now() - share.arrivedAt < MAX_AGE_MS ? share : null;
}

export function isIncomingShareCurrent(share: IncomingShare) {
  return share.generation === generation && Date.now() - share.arrivedAt < MAX_AGE_MS;
}

/** Keep unreadable files available for another attempt, without replacing a newer share. */
export function retryIncomingShare(share: IncomingShare) {
  if (!pending && isIncomingShareCurrent(share)) publish(share);
}

/** Only this newly allocated cache copy is ever deleted; never the sender's URI. */
export async function readIncomingShareFile<T>(
  uri: string,
  maxBytes: number,
  read: (file: File, name: string, mimeType: string) => Promise<T>,
): Promise<T | null> {
  const source = new File(uri);
  const name = source.name || "file";
  const mimeType = source.type;
  const size = source.info().size;
  // Generic Android content providers do not expose bounded reads through FileHandle.
  // Require a measured size before copying instead of copying an unbounded stream.
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0)
    throw new Error("Shared file size is unavailable");
  if (size > maxBytes) return null;
  const copy = new File(Paths.cache, `incoming-share-${Date.now()}-${copyId++}`);
  try {
    await source.copy(copy);
    return await read(copy, name, mimeType);
  } finally {
    if (copy.exists) copy.delete();
  }
}
