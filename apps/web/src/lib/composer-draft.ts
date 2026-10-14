/** Per-thread composer draft persistence (survives tab reloads and discards). */

export const COMPOSER_DRAFT_STORAGE_PREFIX = "rakazo.composerDraft.";

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function getLocalStorage(): DraftStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function composerDraftStorageKey(threadKey: string): string {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}${threadKey}`;
}

export function readComposerDraft(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): string {
  if (!storage || !threadKey) return "";
  try {
    return storage.getItem(composerDraftStorageKey(threadKey)) ?? "";
  } catch {
    return "";
  }
}

export function writeComposerDraft(
  threadKey: string,
  draft: string,
  storage: DraftStorage | null = getLocalStorage(),
): void {
  if (!storage || !threadKey) return;
  try {
    if (draft.length === 0) storage.removeItem(composerDraftStorageKey(threadKey));
    else storage.setItem(composerDraftStorageKey(threadKey), draft);
  } catch {
    // Quota or private-mode failures: the draft still lives in memory.
  }
}
