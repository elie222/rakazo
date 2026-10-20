import {
  clearSharedPayloads,
  getResolvedSharedPayloadsAsync,
  getSharedPayloads,
} from "expo-sharing";
import { Platform } from "react-native";

export type IncomingShare = {
  text: string;
  files: Array<{ uri: string; name: string; mimeType: string | null }>;
};

function isTextShare(shareType: string) {
  return shareType === "text" || shareType === "url";
}

let taking: Promise<IncomingShare | null> | null = null;

/** Takes what another app shared into Rakazo, once. Android only: iOS needs a share extension. */
export function takeIncomingShare(): Promise<IncomingShare | null> {
  if (Platform.OS !== "android") return Promise.resolve(null);
  taking ??= readIncomingShare().finally(() => {
    taking = null;
  });
  return taking;
}

async function readIncomingShare(): Promise<IncomingShare | null> {
  const payloads = getSharedPayloads();
  if (!payloads.length) return null;
  const text = payloads
    .filter((payload) => isTextShare(payload.shareType))
    .map((payload) => payload.value.trim())
    .filter(Boolean)
    .join("\n");
  // Resolving copies shared files into the cache; text and links need no lookup.
  const resolved = payloads.some((payload) => !isTextShare(payload.shareType))
    ? await getResolvedSharedPayloadsAsync().catch(() => [])
    : [];
  clearSharedPayloads();
  const files = resolved.flatMap((payload) =>
    payload.contentUri && !isTextShare(payload.shareType)
      ? [
          {
            uri: payload.contentUri,
            name: payload.originalName ?? "file",
            mimeType: payload.contentMimeType ?? payload.mimeType ?? null,
          },
        ]
      : [],
  );
  return { text, files };
}
