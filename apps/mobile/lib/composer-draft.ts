import type { ComposerMentionBinding } from "@rakazo/core";
import { validateComposerMentionBindings } from "@rakazo/core";
import { Directory, File, Paths } from "expo-file-system";
import { currentApiBase } from "./api";

/** One unsent composer text per server, account, and conversation. */
export type ComposerDraftScope = { apiBase: string; userId: string; threadKey: string };

export type ComposerDraft = { text: string; bindings: ComposerMentionBinding[] };

/** Uses the web draft key (`bot:<id>` or `group:<id>`) inside the server and account. */
export function composerDraftScope(
  userId: string,
  botId: string | undefined,
  groupId: string | undefined,
): ComposerDraftScope | undefined {
  if (!userId || (!botId && !groupId)) return undefined;
  try {
    return {
      apiBase: currentApiBase(),
      userId,
      threadKey: groupId ? `group:${groupId}` : `bot:${botId}`,
    };
  } catch {
    return undefined;
  }
}

// The OS may evict the cache when storage runs low, so an unsent draft lives next to
// the outbox in documents, like a message waiting to be sent.
function root() {
  return new Directory(Paths.document, "composer-drafts-v1");
}
/** Where earlier builds kept drafts. */
function legacyRoot() {
  return new Directory(Paths.cache, "composer-drafts-v1");
}
/** Exists while the earlier drafts are still in the cache but must not be copied again. */
function legacyDone() {
  return new File(Paths.document, "composer-drafts-legacy-done");
}
function draftFolder(drafts: Directory, scope: ComposerDraftScope): Directory {
  return new Directory(
    drafts,
    encodeURIComponent(scope.apiBase),
    `user-${encodeURIComponent(scope.userId)}`,
  );
}

function draftName(scope: ComposerDraftScope): string {
  return `${encodeURIComponent(scope.threadKey)}.json`;
}

function draftFile(drafts: Directory, scope: ComposerDraftScope): File {
  return new File(draftFolder(drafts, scope), draftName(scope));
}

// The next draft is written here first. Native replacement deletes the saved file before
// moving this one in, so after an interrupted move this file holds the newest draft.
function nextDraftFile(drafts: Directory, scope: ComposerDraftScope): File {
  return new File(draftFolder(drafts, scope), `${draftName(scope)}.tmp`);
}

function readDraftRecord(file: File): ComposerDraft | undefined {
  if (!file.exists) return undefined;
  try {
    const record = JSON.parse(file.textSync());
    if (record?.version !== 1 || typeof record.text !== "string") return undefined;
    return {
      text: record.text,
      bindings: validateComposerMentionBindings(record.text, record.bindings),
    };
  } catch {
    return undefined;
  }
}

/** Leftovers are retried on the next draft read or write; a failed delete must not block them. */
function deleteLeftover(entry: File | Directory): void {
  try {
    entry.delete();
  } catch {}
}

/** True when every earlier draft reached the copy unchanged; Android can skip a folder silently. */
function copiedLegacy(source: Directory, copy: Directory): boolean {
  return source.list().every((entry) => {
    if (!(entry instanceof File)) return copiedLegacy(entry, new Directory(copy, entry.name));
    const copied = new File(copy, entry.name);
    return copied.exists && copied.textSync() === entry.textSync();
  });
}

// Android can move a directory by copying and stop halfway, so copy the earlier cache
// drafts instead, keeping the source until a marker records a full copy (as the outbox
// does). The marker is written before any draft on a clean launch too, and stays forever:
// a cache copy that reappears later, after a downgrade, is never trusted over drafts
// saved since.
function migrateLegacyDrafts(): void {
  if (!legacyRoot().exists) {
    if (!legacyDone().exists) {
      // A partial copy left by an interrupted attempt resurfaces here if the system cleared the
      // cache before the next attempt. It is kept: a missing marker cannot tell it apart from
      // drafts saved after a migration whose marker was lost.
      legacyDone().create();
      // iOS can fail to create a file without an error; without the marker, a cache copy a
      // downgrade later leaves behind would replace drafts saved in the meantime.
      if (!legacyDone().exists) throw new Error("DRAFT_STORAGE_UNAVAILABLE");
    }
    return;
  }
  if (!legacyDone().exists) {
    if (root().exists) root().delete();
    legacyRoot().copySync(root());
    if (!copiedLegacy(legacyRoot(), root())) throw new Error("DRAFT_STORAGE_UNAVAILABLE");
    legacyDone().create();
    // iOS can fail to create a file without an error; the source must stay until the marker exists.
    if (!legacyDone().exists) throw new Error("DRAFT_STORAGE_UNAVAILABLE");
  }
  deleteLeftover(legacyRoot());
}

/** Where drafts are read and saved now: the cache until its drafts have been copied. */
function draftsRoot(): Directory {
  try {
    migrateLegacyDrafts();
    return root();
  } catch (error) {
    // The next copy replaces documents with the cache, so until one is verified, drafts are
    // saved where the earlier build left them; a folder the copy keeps skipping must not
    // stop saving and clearing drafts.
    if (legacyRoot().exists && !legacyDone().exists) return legacyRoot();
    throw error;
  }
}

// Moves a draft recovered from an interrupted move back to the saved name, so the next save
// writes a fresh next file instead of truncating the only copy. Throws when the move fails.
function promoteRecoveredDraft(drafts: Directory, scope: ComposerDraftScope): void {
  const next = nextDraftFile(drafts, scope);
  if (!readDraftRecord(draftFile(drafts, scope)) && readDraftRecord(next)) {
    next.moveSync(draftFile(drafts, scope), { overwrite: true });
  }
}

/** Same record as the web binding record; bindings that no longer match the text are dropped. */
export function readComposerDraft(scope: ComposerDraftScope | undefined): ComposerDraft {
  if (!scope) return { text: "", bindings: [] };
  try {
    const drafts = draftsRoot();
    try {
      promoteRecoveredDraft(drafts, scope);
    } catch {
      // Still readable from the next file; the next save retries the move first.
    }
    return (
      readDraftRecord(draftFile(drafts, scope)) ??
      readDraftRecord(nextDraftFile(drafts, scope)) ?? { text: "", bindings: [] }
    );
  } catch {
    // Evicted, corrupt, or unavailable storage starts an empty composer.
    return { text: "", bindings: [] };
  }
}

/** An empty text deletes the draft, so a sent message leaves nothing behind. False when it failed. */
export function writeComposerDraft(
  scope: ComposerDraftScope,
  text: string,
  bindings: readonly ComposerMentionBinding[],
): boolean {
  try {
    const drafts = draftsRoot();
    const file = draftFile(drafts, scope);
    const next = nextDraftFile(drafts, scope);
    if (!text) {
      if (file.exists) file.delete();
      if (next.exists) next.delete();
      return true;
    }
    draftFolder(drafts, scope).create({ intermediates: true, idempotent: true });
    promoteRecoveredDraft(drafts, scope);
    // Replace the saved draft only once the new one is fully written.
    next.create({ overwrite: true });
    next.writeSync(JSON.stringify({ version: 1, text, bindings }));
    next.moveSync(file, { overwrite: true });
    return true;
  } catch {
    // The draft still lives in the composer.
    return false;
  }
}
