import { useEffect, useLayoutEffect, useState } from "react";
import { rpc } from "../query/rpc";
import type { ArtifactTarget } from "./artifact-open";
import { decodeArtifactBase64 } from "./artifact-open";

type ImageDownload = {
  promise: Promise<string>;
  consumers: number;
  objectUrl: string | null;
  settled: boolean;
  bytes: number;
};

const downloads = new Map<string, ImageDownload>();

type ArtifactPicture = { target: ArtifactTarget; artifactId: string };

function downloadKey({ target, artifactId }: ArtifactPicture) {
  return JSON.stringify([
    "botId" in target ? "bot" : "group",
    "botId" in target ? target.botId : target.groupId,
    artifactId,
  ]);
}

function releaseUnusedDownload(key: string, download: ImageDownload) {
  // Keep pending work reusable even if its original consumers leave.
  if (download.consumers || !download.settled) return;
  if (download.objectUrl) URL.revokeObjectURL(download.objectUrl);
  if (downloads.get(key) === download) downloads.delete(key);
}

function acquireDownload(target: ArtifactTarget, artifactId: string) {
  const key = downloadKey({ target, artifactId });
  let download = downloads.get(key);
  if (!download) {
    const entry: ImageDownload = {
      consumers: 0,
      objectUrl: null,
      settled: false,
      bytes: 0,
      promise: rpc.artifacts
        .get({ ...target, artifactId })
        .then((artifact) => {
          const bytes = decodeArtifactBase64(artifact.contentBase64);
          entry.bytes = bytes.byteLength;
          entry.objectUrl = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], { type: artifact.mimeType }),
          );
          return entry.objectUrl;
        })
        .catch((error) => {
          if (downloads.get(key) === entry) downloads.delete(key);
          throw error;
        })
        .finally(() => {
          entry.settled = true;
          releaseUnusedDownload(key, entry);
        }),
    };
    download = entry;
    downloads.set(key, download);
  }
  return { key, entry: download, release: takeShare(key, download) };
}

function takeShare(key: string, entry: ImageDownload) {
  entry.consumers++;
  return () => {
    entry.consumers--;
    releaseUnusedDownload(key, entry);
  };
}

const MAX_KEPT_BYTES = 64 * 1024 * 1024;

export type ArtifactImageKeeper = ReturnType<typeof createArtifactImageKeeper>;

function createArtifactImageKeeper(maxBytes: number) {
  const kept = new Map<string, { bytes: number; release: () => void }>();
  let totalBytes = 0;
  function drop(key: string) {
    const held = kept.get(key);
    if (!held) return;
    kept.delete(key);
    totalBytes -= held.bytes;
    held.release();
  }
  return {
    keep(key: string, entry: ImageDownload) {
      const held = kept.get(key);
      if (held) {
        kept.delete(key);
        kept.set(key, held);
        return;
      }
      kept.set(key, { bytes: entry.bytes, release: takeShare(key, entry) });
      totalBytes += entry.bytes;
      for (const oldest of kept.keys()) {
        // Keep the last opened image even if it alone exceeds the budget.
        if (totalBytes <= maxBytes || kept.size === 1) break;
        drop(oldest);
      }
    },
    retainOnly(pictures: readonly ArtifactPicture[]) {
      const keys = new Set(pictures.map(downloadKey));
      for (const key of kept.keys()) {
        if (!keys.has(key)) drop(key);
      }
    },
    release() {
      for (const key of kept.keys()) drop(key);
    },
  };
}

export function useArtifactImageKeeper(
  pictures: readonly ArtifactPicture[],
  maxBytes = MAX_KEPT_BYTES,
) {
  const [keeper] = useState(() => createArtifactImageKeeper(maxBytes));
  // Prune during commit so a newly opened slide cannot evict a picture that still fits.
  useLayoutEffect(() => keeper.retainOnly(pictures), [keeper, pictures]);
  useEffect(() => () => keeper.release(), [keeper]);
  return keeper;
}

export function useArtifactImage(
  target: ArtifactTarget | undefined,
  artifactId: string,
  enabled = true,
  keeper?: ArtifactImageKeeper,
) {
  const [src, setSrc] = useState<string | null>(null);
  const botId = target && "botId" in target ? target.botId : undefined;
  const groupId = target && "groupId" in target ? target.groupId : undefined;
  useEffect(() => {
    setSrc(null);
    if (!enabled || (!botId && !groupId)) return;
    let cancelled = false;
    const owner: ArtifactTarget = botId ? { botId } : { groupId: groupId! };
    const download = acquireDownload(owner, artifactId);
    void download.entry.promise
      .then((objectUrl) => {
        if (cancelled) return;
        keeper?.keep(download.key, download.entry);
        setSrc(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      download.release();
    };
  }, [artifactId, botId, groupId, enabled, keeper]);
  return src;
}
