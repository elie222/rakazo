import { Directory, File, Paths } from "expo-file-system";
import type { SendAttempt, UnsentDisk } from "./thread-feedback";
import { OUTBOX_MAX_ENTRIES } from "./thread-feedback";

// App-private cache storage is excluded from device backups and may be evicted by the OS.
function root() {
  return new Directory(Paths.cache, "outbox");
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
export const OUTBOX_MAX_BYTES = 50 * 1024 * 1024;
function diskBytes(directory: Directory): number {
  return directory.exists
    ? directory
        .list()
        .reduce((sum, entry) => sum + (entry instanceof File ? entry.size : diskBytes(entry)), 0)
    : 0;
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
      const text = JSON.stringify(attempts.slice(0, OUTBOX_MAX_ENTRIES).map(storedEntry));
      const bytes = new TextEncoder().encode(text).length;
      if (diskBytes(root()) - (target.exists ? target.size : 0) + bytes > OUTBOX_MAX_BYTES) return;
      target.create({ overwrite: true });
      target.write(text);
    } catch {
      /* Optional persistence; the in-memory outbox remains usable. */
    }
  },
  load(session, scope) {
    try {
      const target = file();
      if (!target.exists || diskBytes(root()) > OUTBOX_MAX_BYTES) {
        outboxDisk.clear();
        return [];
      }
      const entries: unknown = JSON.parse(target.textSync());
      if (!Array.isArray(entries)) return [];
      const loaded = entries.slice(0, OUTBOX_MAX_ENTRIES).flatMap((entry): SendAttempt[] => {
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
      const keep = new Set([target.uri, ...loaded.map((a) => folder(a.clientNonce).uri)]);
      for (const entry of root().list()) if (!keep.has(entry.uri)) entry.delete();
      return loaded;
    } catch {
      outboxDisk.clear();
      return [];
    }
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
    try {
      const directory = root();
      if (directory.exists) directory.delete();
    } catch {
      /* Session namespaces prevent reuse even if deletion fails. */
    }
  },
};
