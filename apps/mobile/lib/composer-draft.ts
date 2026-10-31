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

// App-private cache storage, like the outbox: excluded from device backups.
function draftFolder(scope: ComposerDraftScope): Directory {
  return new Directory(
    Paths.cache,
    "composer-drafts-v1",
    encodeURIComponent(scope.apiBase),
    `user-${encodeURIComponent(scope.userId)}`,
  );
}

function draftFile(scope: ComposerDraftScope): File {
  return new File(draftFolder(scope), `${encodeURIComponent(scope.threadKey)}.json`);
}

// The next draft is written here first. Native replacement deletes the saved file before
// moving this one in, so after an interrupted move this file holds the newest draft.
function nextDraftFile(scope: ComposerDraftScope): File {
  return new File(draftFolder(scope), `${encodeURIComponent(scope.threadKey)}.json.tmp`);
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

// Moves a draft recovered from an interrupted move back to the saved name, so the next save
// writes a fresh next file instead of truncating the only copy. Throws when the move fails.
function promoteRecoveredDraft(scope: ComposerDraftScope): void {
  const next = nextDraftFile(scope);
  if (!readDraftRecord(draftFile(scope)) && readDraftRecord(next)) {
    next.moveSync(draftFile(scope), { overwrite: true });
  }
}

/** Same record as the web binding record; bindings that no longer match the text are dropped. */
export function readComposerDraft(scope: ComposerDraftScope | undefined): ComposerDraft {
  if (!scope) return { text: "", bindings: [] };
  try {
    try {
      promoteRecoveredDraft(scope);
    } catch {
      // Still readable from the next file; the next save retries the move first.
    }
    return (
      readDraftRecord(draftFile(scope)) ??
      readDraftRecord(nextDraftFile(scope)) ?? { text: "", bindings: [] }
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
    const file = draftFile(scope);
    const next = nextDraftFile(scope);
    if (!text) {
      if (file.exists) file.delete();
      if (next.exists) next.delete();
      return true;
    }
    draftFolder(scope).create({ intermediates: true, idempotent: true });
    promoteRecoveredDraft(scope);
    // Replace the saved draft only once the new one is fully written.
    next.create({ overwrite: true });
    next.write(JSON.stringify({ version: 1, text, bindings }));
    next.moveSync(file, { overwrite: true });
    return true;
  } catch {
    // The draft still lives in the composer.
    return false;
  }
}
