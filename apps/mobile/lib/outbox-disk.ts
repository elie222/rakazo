import { Directory, File, Paths } from "expo-file-system";
import type { SendAttempt, UnsentDisk } from "./thread-feedback";
import { OUTBOX_MAX_ENTRIES } from "./thread-feedback";

// The OS may evict the cache when storage runs low, so unsent messages live in documents.
function root() {
  return new Directory(Paths.document, "outbox");
}
/** Where earlier builds kept the outbox. */
function legacyRoot() {
  return new Directory(Paths.cache, "outbox");
}
/** Exists while the earlier outbox is still on disk but must not be copied again. */
function legacyDone() {
  return new File(Paths.document, "outbox-legacy-done");
}
function folder(nonce: string) {
  return new Directory(root(), encodeURIComponent(nonce));
}
function attachmentFile(nonce: string, index: number) {
  return new File(folder(nonce), `${index}`);
}
function file() {
  return new File(root(), "sends-v4.json");
}
function replacement() {
  return new File(root(), "sends-v4.json.tmp");
}
function backup() {
  return new File(root(), "sends-v4.json.bak");
}
/** Leftovers are retried on the next load, so a failed delete must not block the outbox. */
function deleteLeftover(entry: File | Directory) {
  try {
    entry.delete();
  } catch {}
}
/** Deletes the earlier outbox, then the marker once nothing is left to copy. */
function removeLegacy() {
  if (legacyRoot().exists) deleteLeftover(legacyRoot());
  if (!legacyRoot().exists && legacyDone().exists) deleteLeftover(legacyDone());
}
/** Android copies a directory it cannot list as empty, so check every file the earlier index needs. */
function copiedLegacy() {
  const names = ["sends-v4.json", "sends-v4.json.bak"];
  for (const name of names) {
    const source = new File(legacyRoot(), name);
    const copy = new File(root(), name);
    if (source.exists && (!copy.exists || copy.textSync() !== source.textSync())) return false;
  }
  return names
    .flatMap((name) => readIndex(new File(legacyRoot(), name)) ?? [])
    .every(
      (entry) =>
        typeof entry?.clientNonce !== "string" ||
        !Array.isArray(entry.payload?.attachments) ||
        entry.payload.attachments.every((_: unknown, index: number) => {
          const source = new File(legacyRoot(), encodeURIComponent(entry.clientNonce), `${index}`);
          const copy = attachmentFile(entry.clientNonce, index);
          return !source.exists || (copy.exists && copy.size === source.size);
        }),
    );
}
// Android can move a directory by copying and deleting, and stop halfway. Copy instead, keeping
// the source until the marker records a full copy; a copy that stopped is discarded and redone.
function moveLegacyOutbox() {
  if (legacyRoot().exists && !legacyDone().exists) {
    if (root().exists) root().delete();
    legacyRoot().copySync(root());
    if (!copiedLegacy()) throw new Error("OUTBOX_STORAGE_UNAVAILABLE");
    legacyDone().create();
    // iOS can fail to create a file without an error; the source must stay until the marker exists.
    if (!legacyDone().exists) throw new Error("OUTBOX_STORAGE_UNAVAILABLE");
  }
  removeLegacy();
}
export const OUTBOX_MAX_BYTES = 50 * 1024 * 1024;
// Copies of the index left by an interrupted save do not count; load removes them.
function diskBytes(directory: Directory): number {
  const scratch = [replacement().uri, backup().uri];
  return directory.exists
    ? directory
        .list()
        .filter((entry) => !scratch.includes(entry.uri))
        .reduce((sum, entry) => sum + (entry instanceof File ? entry.size : diskBytes(entry)), 0)
    : 0;
}
/** A parsed index, or undefined when it is missing or corrupt. Read errors propagate. */
function readIndex(index: File) {
  if (!index.exists) return undefined;
  const text = index.textSync();
  try {
    const entries: unknown = JSON.parse(text);
    return Array.isArray(entries) ? entries : undefined;
  } catch {
    return undefined;
  }
}
/** The committed index entries, restoring the backup when the index is missing or corrupt. */
function committedIndex() {
  const entries = readIndex(file());
  if (entries) return entries;
  // A save interrupted between its two moves leaves only the previous index, as the backup.
  // Never restore the replacement: its save reported failure.
  const previous = readIndex(backup());
  if (previous) backup().moveSync(file(), { overwrite: true });
  return previous;
}
function storedEntry(attempt: SendAttempt) {
  return {
    ...attempt,
    state: attempt.state === "pending" ? "queued" : attempt.state,
    artifactIds: [...attempt.artifactIds],
    payload: {
      ...attempt.payload,
      attachments: attempt.payload.attachments.map(
        ({ contentBase64: _bytes, previewUri: _preview, ...attachment }) => attachment,
      ),
    },
  };
}
export const outboxDisk: UnsentDisk = {
  admit(attempt) {
    try {
      if (folder(attempt.clientNonce).exists) return false;
      const bytes = attempt.payload.attachments.reduce(
        (sum, a) => sum + Math.floor((a.contentBase64.length * 3) / 4),
        0,
      );
      if (
        diskBytes(root()) +
          bytes +
          new TextEncoder().encode(JSON.stringify(storedEntry(attempt))).length +
          2 >
        OUTBOX_MAX_BYTES
      )
        return false;
      folder(attempt.clientNonce).create({ intermediates: true, idempotent: true });
      attempt.payload.attachments.forEach((attachment, index) => {
        const target = attachmentFile(attempt.clientNonce, index);
        target.create();
        target.write(attachment.contentBase64, { encoding: "base64" });
        attachment.previewUri = attachment.mimeType.startsWith("image/") ? target.uri : undefined;
      });
      for (const attachment of attempt.payload.attachments) attachment.contentBase64 = "";
      return true;
    } catch {
      outboxDisk.forget(attempt);
      throw new Error("OUTBOX_STORAGE_UNAVAILABLE");
    }
  },
  save(attempts) {
    try {
      root().create({ intermediates: true, idempotent: true });
      const target = file();
      const next = replacement();
      const text = JSON.stringify(attempts.slice(0, OUTBOX_MAX_ENTRIES).map(storedEntry));
      const bytes = new TextEncoder().encode(text).length;
      if (diskBytes(root()) - (target.exists ? target.size : 0) + bytes > OUTBOX_MAX_BYTES)
        throw new Error("Outbox full");
      // A failed save can leave a partial index next to the committed backup; never set it aside over that backup.
      if (backup().exists) committedIndex();
      next.create({ overwrite: true });
      next.write(text);
      // Moving over a file deletes it first, so set the committed index aside until the new one is in place.
      // A move points its source object at the destination, so each move gets a fresh destination.
      if (target.exists) target.moveSync(backup(), { overwrite: true });
      try {
        next.moveSync(file());
      } catch (error) {
        // Android can move by copying and then fail to delete the source; the copy is then committed.
        const index = file();
        if (!index.exists || index.textSync() !== text) throw error;
        deleteLeftover(replacement());
      }
    } catch {
      throw new Error("OUTBOX_STORAGE_UNAVAILABLE");
    }
    // The new index is committed; load removes a backup that could not be deleted.
    const previous = backup();
    if (previous.exists) deleteLeftover(previous);
  },
  load(session, scope) {
    // Storage errors propagate without wiping anything, so a later load retries.
    moveLegacyOutbox();
    const target = file();
    const entries = committedIndex();
    if (!entries || diskBytes(root()) > OUTBOX_MAX_BYTES) {
      outboxDisk.clear();
      return [];
    }
    let loaded: SendAttempt[];
    try {
      loaded = entries.slice(0, OUTBOX_MAX_ENTRIES).flatMap((entry): SendAttempt[] => {
        if (
          entry?.apiBase !== scope.apiBase ||
          entry.userId !== scope.userId ||
          entry.cacheSession !== scope.cacheSession ||
          !(entry.spaceId === null || typeof entry.spaceId === "string") ||
          typeof entry.clientNonce !== "string" ||
          !/^[A-Za-z0-9_-]{1,200}$/.test(entry.clientNonce) ||
          !["queued", "failed", "refused"].includes(entry.state) ||
          typeof entry.payload?.originThreadKey !== "string" ||
          typeof entry.payload.displayText !== "string" ||
          !entry.payload.plan ||
          !Array.isArray(entry.payload.plan.routineIds) ||
          !Array.isArray(entry.payload.plan.mentionPayload) ||
          !Array.isArray(entry.payload.attachments) ||
          !Array.isArray(entry.artifactIds) ||
          !entry.artifactIds.every(
            (pair: unknown) =>
              Array.isArray(pair) &&
              pair.length === 2 &&
              pair.every((id) => typeof id === "string"),
          )
        )
          return [];
        const attachments = entry.payload.attachments.map(
          (attachment: SendAttempt["payload"]["attachments"][number], index: number) => ({
            ...attachment,
            contentBase64: "",
            previewUri: attachment.mimeType?.startsWith("image/")
              ? attachmentFile(entry.clientNonce, index).uri
              : undefined,
          }),
        );
        return [
          {
            ...entry,
            session,
            artifactIds: new Map(entry.artifactIds),
            payload: { ...entry.payload, attachments },
          },
        ];
      });
    } catch {
      outboxDisk.clear();
      return [];
    }
    const keep = new Set([target.uri, ...loaded.map((a) => folder(a.clientNonce).uri)]);
    for (const entry of root().list()) if (!keep.has(entry.uri)) deleteLeftover(entry);
    return loaded;
  },
  async hydrate(attempt) {
    for (const [index, attachment] of attempt.payload.attachments.entries()) {
      if (attachment.contentBase64 || attempt.artifactIds.has(attachment.id)) continue;
      const target = attachmentFile(attempt.clientNonce, index);
      if (!target.exists) throw new Error("ATTACHMENT_UNAVAILABLE");
      attachment.contentBase64 = await target.base64();
    }
  },
  forget(attempt) {
    try {
      const directory = folder(attempt.clientNonce);
      if (directory.exists) directory.delete();
    } catch {}
  },
  clear() {
    // Until the earlier outbox is gone, the marker keeps load from copying discarded messages back,
    // so it comes first: a clear that stops after deleting the outbox must not bring them back.
    try {
      if (legacyRoot().exists && !legacyDone().exists) legacyDone().create();
    } catch {}
    try {
      const directory = root();
      if (directory.exists) directory.delete();
    } catch {
      /* Session namespaces prevent reuse even if deletion fails. */
    }
    removeLegacy();
    if (legacyRoot().exists && !legacyDone().exists) throw new Error("OUTBOX_STORAGE_UNAVAILABLE");
  },
};
