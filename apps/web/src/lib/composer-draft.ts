import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type { ComposerMentionBinding } from "@rakazo/core";
import {
  createKeyedListeners,
  newClientId,
  validateComposerDraftSkill,
  validateComposerMentionBindings,
} from "@rakazo/core";

export const COMPOSER_DRAFT_STORAGE_PREFIX = "rakazo.composerDraft.";
const COMPOSER_BINDINGS_STORAGE_PREFIX = "rakazo.composerBindings.";
const COMPOSER_NONCE_STORAGE_PREFIX = "rakazo.composerNonce.";

/** `appended`: words added from outside the composer while this send was in flight. */
type ComposerDraftSubmission = {
  text: string;
  bindingRecord: string | null;
  owner: string | null;
  appended?: string;
};
const pendingSubmissions = new Map<string, ComposerDraftSubmission>();
const acceptedListeners = new Map<string, Set<(text: string) => void>>();
const replacedDrafts = createKeyedListeners<string>();

/** The composer showing a chat follows its saved draft when something else rewrites it. */
export const subscribeComposerDraftReplaced = replacedDrafts.subscribe;

function savedDraftOf(submission: ComposerDraftSubmission): string {
  if (!submission.appended) return submission.text;
  return submission.text ? `${submission.text} ${submission.appended}` : submission.appended;
}

/**
 * Adds words to a chat's saved draft from outside its composer, such as a dictation that
 * finished after the chat was left. A composer showing that chat shows them. A send still in
 * flight from that draft keeps its settlement: once accepted, only the added words remain.
 */
export function appendComposerDraftText(threadKey: string, text: string): void {
  const saved = readComposerDraft(threadKey);
  const next = saved ? `${saved} ${text}` : text;
  const pending = pendingSubmissions.get(threadKey);
  // Only a draft still holding the in-flight text and its mention bindings belongs to that
  // send; another tab can rebind the same text to another mention.
  const inFlight =
    pending &&
    savedDraftOf(pending) === saved &&
    readComposerDraftOwner(threadKey) === pending.owner &&
    readBindingRecord(threadKey) === pending.bindingRecord
      ? pending
      : null;
  writeComposerDraft(
    threadKey,
    next,
    undefined,
    readComposerDraftBindings(threadKey),
    readComposerDraftSkill(threadKey),
  );
  if (inFlight) {
    inFlight.appended = inFlight.appended ? `${inFlight.appended} ${text}` : text;
    inFlight.bindingRecord = readBindingRecord(threadKey);
    writeNonceRecord(threadKey, null, getLocalStorage());
    inFlight.owner = readComposerDraftOwner(threadKey);
    pendingSubmissions.set(threadKey, inFlight);
  }
  replacedDrafts.emit(threadKey, next);
}

/** Rewrites a chat's saved draft from outside its composer; a composer showing it follows. */
export function replaceComposerDraft(
  threadKey: string,
  text: string,
  bindings: readonly ComposerMentionBinding[],
  skill: AgentSkillCatalogEntry | null = null,
): void {
  writeComposerDraft(threadKey, text, undefined, bindings, skill);
  replacedDrafts.emit(threadKey, text);
}

export function beginComposerDraftSubmission(
  threadKey: string,
  text: string,
  recoverable?: {
    nonce: string;
    bindings: readonly ComposerMentionBinding[];
    skill: AgentSkillCatalogEntry | null;
  },
): ComposerDraftSubmission {
  // An unchanged empty body can still hold a skill chip; beginning a send must not clear it.
  if (text || text !== readComposerDraft(threadKey)) writeComposerDraft(threadKey, text);
  const submission: ComposerDraftSubmission = {
    text,
    bindingRecord: readBindingRecord(threadKey),
    owner: null,
  };
  // Persist before dispatch: a new document loses this module and callback.
  // Partially saved metadata or another composer's payload cannot inherit this nonce.
  const matches =
    recoverable &&
    readComposerDraft(threadKey) === text &&
    JSON.stringify(readComposerDraftBindings(threadKey)) === JSON.stringify(recoverable.bindings) &&
    JSON.stringify(readComposerDraftSkill(threadKey)) === JSON.stringify(recoverable.skill);
  writeNonceRecord(threadKey, matches ? recoverable.nonce : null, getLocalStorage());
  submission.owner = readComposerDraftOwner(threadKey);
  pendingSubmissions.set(threadKey, submission);
  return submission;
}

export function settleComposerDraftSubmission(
  threadKey: string,
  submission: ComposerDraftSubmission,
  accepted: boolean,
): void {
  if (pendingSubmissions.get(threadKey) !== submission) return;
  pendingSubmissions.delete(threadKey);
  if (
    !accepted ||
    readComposerDraft(threadKey) !== savedDraftOf(submission) ||
    readBindingRecord(threadKey) !== submission.bindingRecord ||
    readComposerDraftOwner(threadKey) !== submission.owner
  )
    return;
  if (submission.appended) {
    writeComposerDraft(threadKey, submission.appended, undefined, []);
    replacedDrafts.emit(threadKey, submission.appended);
    return;
  }
  writeComposerDraft(threadKey, "");
  for (const listener of acceptedListeners.get(threadKey) ?? []) listener(submission.text);
}

let sendingWork = false;
let attachmentWork = false;

/**
 * The shell reports work a reload would lose: a send (typed or spoken) until the server answers,
 * or picked attachments, which live only in memory.
 */
export function setComposerUnsavedWork(work: { sending: boolean; attachments: boolean }): void {
  sendingWork = work.sending;
  attachmentWork = work.attachments;
}

/** A send waiting for its answer, or attachments that only exist in memory. */
export function composerHoldsUnsavedWork(): boolean {
  return composerHoldsWorkInFlight() || attachmentWork;
}

/** A send waiting for its answer. Unlike picked attachments, it finishes on its own. */
export function composerHoldsWorkInFlight(): boolean {
  return pendingSubmissions.size > 0 || sendingWork;
}

/** Unsaved composer work, or saved text or a skill chip that has not been sent. */
export function hasUnsentComposerDraft(storage: Storage | null = null): boolean {
  if (composerHoldsUnsavedWork()) return true;
  try {
    const drafts = storage ?? localStorage;
    const keys = Array.from({ length: drafts.length }, (_, index) => drafts.key(index));
    for (const key of keys) {
      if (key?.startsWith(COMPOSER_DRAFT_STORAGE_PREFIX) && drafts.getItem(key)) return true;
      if (
        key?.startsWith(COMPOSER_BINDINGS_STORAGE_PREFIX) &&
        readComposerDraftSkill(key.slice(COMPOSER_BINDINGS_STORAGE_PREFIX.length), drafts)
      )
        return true;
    }
  } catch {
    // Without storage the draft lives only in memory, so treat it as unsent.
    return true;
  }
  return false;
}

/** Signing out leaves no saved draft, its mentions or its retry nonce for whoever uses this browser next. */
export function clearComposerDrafts(): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    for (const key of keys) {
      if (
        key?.startsWith(COMPOSER_DRAFT_STORAGE_PREFIX) ||
        key?.startsWith(COMPOSER_BINDINGS_STORAGE_PREFIX) ||
        key?.startsWith(COMPOSER_NONCE_STORAGE_PREFIX)
      )
        localStorage.removeItem(key);
    }
  } catch {
    // Without storage no draft was saved.
  }
}

export function subscribeComposerDraftAccepted(
  threadKey: string,
  listener: (text: string) => void,
): () => void {
  let listeners = acceptedListeners.get(threadKey);
  if (!listeners) {
    listeners = new Set();
    acceptedListeners.set(threadKey, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) acceptedListeners.delete(threadKey);
  };
}

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

export function composerDraftBindingsKey(threadKey: string): string {
  return `${COMPOSER_BINDINGS_STORAGE_PREFIX}${threadKey}`;
}

function composerNonceStorageKey(threadKey: string): string {
  return `${COMPOSER_NONCE_STORAGE_PREFIX}${threadKey}`;
}

/**
 * The nonce of a send that ended without its answer, kept beside a draft the
 * user has not touched, so an unchanged retry is recognized as the same
 * message instead of creating a duplicate.
 */
export function readComposerRetryNonce(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): string | null {
  if (!storage || !threadKey) return null;
  try {
    const raw = storage.getItem(composerNonceStorageKey(threadKey));
    if (!raw) return null;
    const record = JSON.parse(raw);
    return record?.version === 1 &&
      typeof record.nonce === "string" &&
      record.text === readComposerDraft(threadKey, storage) &&
      record.bindingRecord === readBindingRecord(threadKey, storage)
      ? record.nonce
      : null;
  } catch {
    return null;
  }
}

function readComposerDraftOwner(threadKey: string, storage = getLocalStorage()): string | null {
  try {
    const record = JSON.parse(storage?.getItem(composerNonceStorageKey(threadKey)) ?? "null");
    return record?.version === 1 && typeof record.owner === "string" ? record.owner : null;
  } catch {
    return null;
  }
}

/** Transient context claims this document's draft without changing its saved operation. */
export function touchComposerDraftContext(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): void {
  const owner = readComposerDraftOwner(threadKey, storage);
  if (owner === null) return;
  writeNonceRecord(
    threadKey,
    readComposerRetryNonce(threadKey, storage),
    storage,
    pendingSubmissions.get(threadKey)?.owner === owner ? owner : null,
  );
}

function writeNonceRecord(
  threadKey: string,
  nonce: string | null,
  storage: DraftStorage | null,
  owner: string | null = null,
): void {
  if (!storage || !threadKey) return;
  try {
    storage.setItem(
      composerNonceStorageKey(threadKey),
      JSON.stringify({
        version: 1,
        owner: owner ?? newClientId(),
        nonce,
        text: readComposerDraft(threadKey, storage),
        bindingRecord: readBindingRecord(threadKey, storage),
      }),
    );
  } catch {
    // The in-memory nonce still covers the retry while this chat stays open.
  }
}

function readBindingRecord(threadKey: string, storage = getLocalStorage()): string | null {
  try {
    return storage?.getItem(composerDraftBindingsKey(threadKey)) ?? null;
  } catch {
    return null;
  }
}

/** Bindings and the skill chip are optional metadata; a stale record must never replace the raw text. */
function readDraftMetadata(threadKey: string, storage: DraftStorage | null) {
  if (!storage || !threadKey) return null;
  const key = composerDraftBindingsKey(threadKey);
  try {
    const raw = readBindingRecord(threadKey, storage);
    if (!raw) return null;
    const record = JSON.parse(raw);
    const text = readComposerDraft(threadKey, storage);
    if (record?.version !== 1 || record.text !== text) {
      storage.removeItem(key);
      return null;
    }
    return {
      bindings: validateComposerMentionBindings(text, record.bindings),
      skill: record.skill === undefined ? null : validateComposerDraftSkill(record.skill),
    };
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* The in-memory draft remains usable. */
    }
    return null;
  }
}

export function readComposerDraftBindings(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): ComposerMentionBinding[] {
  return readDraftMetadata(threadKey, storage)?.bindings ?? [];
}

/** The skill chip picked for the saved draft, kept with its mentions. */
export function readComposerDraftSkill(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): AgentSkillCatalogEntry | null {
  return readDraftMetadata(threadKey, storage)?.skill ?? null;
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
  bindings?: readonly ComposerMentionBinding[],
  skill: AgentSkillCatalogEntry | null = null,
): void {
  pendingSubmissions.delete(threadKey);
  if (!storage || !threadKey) return;
  try {
    // Every saved write retires the previous submission, even for identical text.
    storage.removeItem(composerNonceStorageKey(threadKey));
    // Plain-text callers preserve bindings only when they are resubmitting the
    // unchanged draft. New text without bindings cannot inherit old identities,
    // and a changed draft no longer matches the nonce its predecessor left.
    if (bindings !== undefined || draft !== readComposerDraft(threadKey, storage) || !draft) {
      storage.removeItem(composerDraftBindingsKey(threadKey));
    }
    if (draft.length === 0) storage.removeItem(composerDraftStorageKey(threadKey));
    else storage.setItem(composerDraftStorageKey(threadKey), draft);
    if (bindings !== undefined && (bindings.length || skill)) {
      storage.setItem(
        composerDraftBindingsKey(threadKey),
        JSON.stringify({ version: 1, text: draft, bindings, ...(skill ? { skill } : {}) }),
      );
    }
  } catch {
    // Quota or private-mode failures: the draft still lives in memory.
  }
}

/** The composer key for a chat: one bot's chat or a group's. */
export function composerDraftKey(target: { botId: string } | { groupId: string }): string {
  return "botId" in target ? `bot:${target.botId}` : `group:${target.groupId}`;
}

const composerOffers = createKeyedListeners<string>();

/** Text a card in the chat hands to that chat's composer; the person still sends it. */
export const offerComposerText = composerOffers.emit;
export const subscribeComposerOffer = composerOffers.subscribe;
