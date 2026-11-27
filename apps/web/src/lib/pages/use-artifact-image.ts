import { useEffect, useLayoutEffect, useState } from "react";
import { rpc } from "../query/rpc";
import type { ArtifactTarget } from "./artifact-open";
import { decodeArtifactBase64 } from "./artifact-open";

type ImageDownload = {
  promise: Promise<string>;
  consumers: number;
  objectUrl: string | null;
  settled: boolean;
  /** Size of the picture, known once the download settles. */
  bytes: number;
};

const downloads = new Map<string, ImageDownload>();

function downloadKey(target: ArtifactTarget, artifactId: string) {
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

/** The picture's download, started now if there is none yet. */
function downloadFor(target: ArtifactTarget, artifactId: string) {
  const key = downloadKey(target, artifactId);
  const held = downloads.get(key);
  if (held) return { key, entry: held };
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
  downloads.set(key, entry);
  return { key, entry };
}

/** Counts one more holder of the download, and returns what lets that holder go. */
function takeShare(key: string, entry: ImageDownload) {
  entry.consumers++;
  return () => {
    entry.consumers--;
    releaseUnusedDownload(key, entry);
  };
}

function acquireDownload(target: ArtifactTarget, artifactId: string) {
  const { key, entry } = downloadFor(target, artifactId);
  return { promise: entry.promise, release: takeShare(key, entry) };
}

/** One picture to download: the chat that holds it, and the artifact. */
export type ArtifactPicture = { target: ArtifactTarget; artifactId: string };

/**
 * Holds one share in the download of each picture it is given, past the components that showed
 * it, and lets go of the least recently shown ones once they pass a byte budget.
 */
export type ArtifactImageKeeper = {
  /**
   * Keeps the picture, counting it as the most recently shown one. It never lets anything go:
   * a picture under this one asks before the owner has pruned the pictures that left.
   */
  keep(picture: ArtifactPicture): void;
  /** Lets go of every kept picture that is not among these. */
  retainOnly(pictures: readonly ArtifactPicture[]): void;
};

/** How many bytes of pictures a keeper holds at most. */
const MAX_KEPT_BYTES = 64 * 1024 * 1024;

type KeptShare = { entry: ImageDownload; release: () => void };

export function createArtifactImageKeeper(maxBytes: number) {
  // In order of being shown, the least recent first.
  const kept = new Map<string, KeptShare>();
  const letGo = (key: string, held: KeptShare) => {
    kept.delete(key);
    held.release();
  };
  const trim = () => {
    let total = 0;
    let ready = 0;
    for (const { entry } of kept.values()) {
      total += entry.bytes;
      if (entry.objectUrl) ready += 1;
    }
    for (const [key, held] of kept) {
      // The last picture that has finished stays even when it alone is over the budget.
      // A download still running has no bytes, so it is not that picture and it is not
      // dropped here: its size counts once it succeeds.
      if (total <= maxBytes || ready <= 1) return;
      if (!held.entry.objectUrl) continue;
      total -= held.entry.bytes;
      ready -= 1;
      letGo(key, held);
    }
  };
  return {
    keep({ target, artifactId }: ArtifactPicture) {
      const { key, entry } = downloadFor(target, artifactId);
      const held = kept.get(key);
      if (held?.entry === entry) {
        // Shown again, so it is now the most recent.
        kept.delete(key);
        kept.set(key, held);
      } else {
        // A retry after a failure downloads into a new entry, which takes the place of the old.
        if (held) letGo(key, held);
        kept.set(key, { entry, release: takeShare(key, entry) });
        // The budget applies when this download succeeds and the keeper still holds it.
        // A picture already dropped must not trim. A failure adds nothing, so it drops
        // only this picture.
        void entry.promise.then(
          () => {
            if (kept.get(key)?.entry === entry) trim();
          },
          () => {
            const current = kept.get(key);
            if (current?.entry === entry) letGo(key, current);
          },
        );
      }
    },
    retainOnly(pictures: readonly ArtifactPicture[]) {
      const shown = new Set(
        pictures.map((picture) => downloadKey(picture.target, picture.artifactId)),
      );
      for (const [key, held] of kept) {
        if (!shown.has(key)) letGo(key, held);
      }
    },
    /** Lets go of everything it kept, and stays usable afterwards. */
    release() {
      for (const held of kept.values()) held.release();
      kept.clear();
    },
  };
}

/**
 * A keeper for as long as the component is mounted. It holds only pictures that are still in
 * `pictures`.
 */
export function useArtifactImageKeeper(
  pictures: readonly ArtifactPicture[],
  maxBytes = MAX_KEPT_BYTES,
): ArtifactImageKeeper {
  const [keeper] = useState(() => createArtifactImageKeeper(maxBytes));
  // With the commit itself, not in an effect after it: the effects under this component run
  // later, and a kept download can settle in between. Asking never lets anything go, so an
  // effect under this component that asks first cannot let anything go either.
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
    keeper?.keep({ target: owner, artifactId });
    void download.promise
      .then((objectUrl) => {
        if (!cancelled) setSrc(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      download.release();
    };
  }, [artifactId, botId, groupId, enabled, keeper]);
  return src;
}
