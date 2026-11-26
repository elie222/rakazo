import type { ComposerMentionBinding } from "@rakazo/core";
import { createKeyedListeners, newClientId, validateComposerMentionBindings } from "@rakazo/core";
import { clearStoredFailedSends, hasStoredFailedSends } from "./pending-send";

export const COMPOSER_DRAFT_STORAGE_PREFIX = "rakazo.composerDraft.";
const COMPOSER_BINDINGS_STORAGE_PREFIX = "rakazo.composerBindings.";
const COMPOSER_NONCE_STORAGE_PREFIX = "rakazo.composerNonce.";
const COMPOSER_VERSION_STORAGE_PREFIX = "rakazo.composerVersion.";
const LEGACY_COMPOSER_SEND_STORAGE_PREFIX = "rakazo.composerSend.";

// Older releases saved full send payloads. Remove them on upgrade, including chats
// that are never opened again; only retry nonces are stored by this release.
try {
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  for (const key of keys) {
    if (key?.startsWith(LEGACY_COMPOSER_SEND_STORAGE_PREFIX)) localStorage.removeItem(key);
  }
} catch {
  // Storage may be unavailable during server rendering or in private mode.
}

/** `appended`: words added from outside the composer while this send was in flight. */
type ComposerDraftSubmission = {
  text: string;
  bindingRecord: string | null;
  revision: number;
  version: string | null;
  appended?: string;
};
export type ComposerDraftSnapshot = {
  text: string;
  bindingRecord: string | null;
  revision: number;
  version: string | null;
  persisted: boolean;
  submission?: ComposerDraftSubmission;
};
const draftRevisions = new Map<string, number>();
const pendingSubmissions = new Map<string, ComposerDraftSubmission>();
const acceptedListeners = new Map<
  string,
  Set<(text: string, bindingRecord: string | null) => void>
>();
const replacedDrafts = createKeyedListeners<string>();

/** The composer showing a chat follows its saved draft when something else rewrites it. */
export const subscribeComposerDraftReplaced = replacedDrafts.subscribe;

function savedDraftOf(submission: ComposerDraftSubmission): string {
  return submission.appended ? `${submission.text} ${submission.appended}` : submission.text;
}

function sameSubmittedDraft(
  threadKey: string,
  expected: {
    text: string;
    bindingRecord: string | null;
    revision: number;
    version: string | null;
  },
): boolean {
  return (
    (draftRevisions.get(threadKey) ?? 0) === expected.revision &&
    readDraftVersion(threadKey) === expected.version &&
    readComposerDraft(threadKey) === expected.text &&
    readCanonicalBindingRecord(threadKey, expected.text) === expected.bindingRecord
  );
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
  // send; another tab can rebind the same text to another mention or rewrite it.
  const inFlight =
    pending && sameSubmittedDraft(threadKey, { ...pending, text: savedDraftOf(pending) })
      ? pending
      : null;
  writeComposerDraft(threadKey, next, undefined, readComposerDraftBindings(threadKey));
  if (inFlight) {
    inFlight.appended = inFlight.appended ? `${inFlight.appended} ${text}` : text;
    inFlight.bindingRecord = readCanonicalBindingRecord(threadKey, next);
    inFlight.revision = draftRevisions.get(threadKey) ?? 0;
    inFlight.version = readDraftVersion(threadKey);
    pendingSubmissions.set(threadKey, inFlight);
  }
  replacedDrafts.emit(threadKey, next);
}

/** Rewrites a chat's saved draft from outside its composer; a composer showing it follows. */
export function replaceComposerDraft(
  threadKey: string,
  text: string,
  bindings: readonly ComposerMentionBinding[],
): void {
  writeComposerDraft(threadKey, text, undefined, bindings);
  replacedDrafts.emit(threadKey, text);
}

export function beginComposerDraftSubmission(
  threadKey: string,
  text: string,
): ComposerDraftSubmission {
  writeComposerDraft(threadKey, text);
  // The send that begins now carries its own nonce; a stored one is consumed.
  writeComposerRetryNonce(threadKey, null);
  const submission = {
    text,
    bindingRecord: readCanonicalBindingRecord(threadKey, text),
    revision: draftRevisions.get(threadKey) ?? 0,
    version: readDraftVersion(threadKey),
  };
  pendingSubmissions.set(threadKey, submission);
  return submission;
}

export function settleComposerDraftSubmission(
  threadKey: string,
  submission: ComposerDraftSubmission,
  accepted: boolean,
): boolean {
  if (pendingSubmissions.get(threadKey) !== submission) return false;
  pendingSubmissions.delete(threadKey);
  if (
    !accepted ||
    !sameSubmittedDraft(threadKey, { ...submission, text: savedDraftOf(submission) })
  )
    return false;
  if (submission.appended) {
    writeComposerDraft(threadKey, submission.appended);
    replacedDrafts.emit(threadKey, submission.appended);
    return true;
  }
  writeComposerDraft(threadKey, "");
  for (const listener of acceptedListeners.get(threadKey) ?? [])
    listener(submission.text, submission.bindingRecord);
  return true;
}

/** Captures the chat's current saved draft state directly from storage. */
export function captureCurrentComposerDraftSnapshot(
  threadKey: string,
  text: string,
): ComposerDraftSnapshot {
  const persisted = text.length > 0 && readComposerDraft(threadKey) === text;
  return {
    text,
    bindingRecord: persisted ? readCanonicalBindingRecord(threadKey, text) : null,
    revision: draftRevisions.get(threadKey) ?? 0,
    version: readDraftVersion(threadKey),
    persisted,
  };
}

/**
 * Captures the active in-flight submission's raw draft and mention bindings, or falls back to
 * the caller's text with stored bindings when called outside `Composer`.
 */
export function captureComposerDraftSnapshot(
  threadKey: string,
  fallbackText: string,
): ComposerDraftSnapshot {
  const pending = pendingSubmissions.get(threadKey);
  if (pending) {
    return {
      text: pending.text,
      bindingRecord: pending.bindingRecord,
      revision: pending.revision,
      version: pending.version,
      persisted: pending.text.length > 0 && readComposerDraft(threadKey) === pending.text,
      submission: pending,
    };
  }
  return captureCurrentComposerDraftSnapshot(threadKey, fallbackText);
}

/** True when the chat's saved draft still holds this exact captured write, unchanged in any tab. */
export function matchesComposerDraftSnapshot(
  threadKey: string,
  snapshot: ComposerDraftSnapshot,
): boolean {
  return sameSubmittedDraft(threadKey, snapshot);
}

/**
 * True when the saved draft changed (in this tab or another) after this send began.
 * Handles both persisted drafts and sends without storage (e.g., private mode or direct tests).
 */
export function hasComposerDraftChangedSince(
  threadKey: string,
  snapshot: ComposerDraftSnapshot,
): boolean {
  if (snapshot.persisted) return !sameSubmittedDraft(threadKey, snapshot);
  return (
    (draftRevisions.get(threadKey) ?? 0) !== snapshot.revision ||
    readDraftVersion(threadKey) !== snapshot.version ||
    readComposerDraft(threadKey) !== ""
  );
}

/**
 * Clears the saved draft and notifies any mounted composer when the chat still holds the exact
 * raw text, mention bindings, and write version that were submitted, leaving newer edits intact.
 */
export function clearAcceptedComposerDraft(
  threadKey: string,
  snapshot: ComposerDraftSnapshot,
): void {
  const appended = snapshot.submission?.appended;
  if (appended && snapshot.submission) {
    if (
      sameSubmittedDraft(threadKey, {
        ...snapshot.submission,
        text: savedDraftOf(snapshot.submission),
      })
    ) {
      writeComposerDraft(threadKey, appended);
      replacedDrafts.emit(threadKey, appended);
    }
    return;
  }
  if (!snapshot.text || !sameSubmittedDraft(threadKey, snapshot)) return;
  writeComposerDraft(threadKey, "");
  for (const listener of acceptedListeners.get(threadKey) ?? [])
    listener(snapshot.text, snapshot.bindingRecord);
}

/**
 * Keeps a failed send's nonce beside the saved draft only while that draft is
 * still the exact write it sent, mentions included, so a retry cannot reuse it
 * for a different payload.
 */
export function keepComposerRetryNonce(
  threadKey: string,
  submission: ComposerDraftSubmission,
  nonce: string,
): void {
  if (sameSubmittedDraft(threadKey, submission)) writeComposerRetryNonce(threadKey, nonce);
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

/** A send waiting for its answer, or attachments / failed sends that only exist in memory. */
export function composerHoldsUnsavedWork(): boolean {
  return composerHoldsWorkInFlight() || attachmentWork || hasStoredFailedSends();
}

/** A send waiting for its answer. Unlike picked attachments, it finishes on its own. */
export function composerHoldsWorkInFlight(): boolean {
  return pendingSubmissions.size > 0 || sendingWork;
}

/** Unsaved composer work, or saved text in any composer that has not been sent. */
export function hasUnsentComposerDraft(storage: Storage | null = null): boolean {
  if (composerHoldsUnsavedWork()) return true;
  try {
    const drafts = storage ?? localStorage;
    for (let index = 0; index < drafts.length; index++) {
      const key = drafts.key(index);
      if (key?.startsWith(COMPOSER_DRAFT_STORAGE_PREFIX) && drafts.getItem(key)) return true;
    }
  } catch {
    // Without storage the draft lives only in memory, so treat it as unsent.
    return true;
  }
  return false;
}

/** Signing out leaves no saved draft, its mentions, its failed rows or its retry nonce for whoever uses this browser next. */
export function clearComposerDrafts(): void {
  clearStoredFailedSends();
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    for (const key of keys) {
      if (
        key?.startsWith(COMPOSER_DRAFT_STORAGE_PREFIX) ||
        key?.startsWith(COMPOSER_BINDINGS_STORAGE_PREFIX) ||
        key?.startsWith(COMPOSER_NONCE_STORAGE_PREFIX) ||
        key?.startsWith(COMPOSER_VERSION_STORAGE_PREFIX) ||
        key?.startsWith(LEGACY_COMPOSER_SEND_STORAGE_PREFIX)
      )
        localStorage.removeItem(key);
    }
  } catch {
    // Without storage no draft was saved.
  }
}

export function subscribeComposerDraftAccepted(
  threadKey: string,
  listener: (text: string, bindingRecord: string | null) => void,
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

function composerVersionStorageKey(threadKey: string): string {
  return `${COMPOSER_VERSION_STORAGE_PREFIX}${threadKey}`;
}

function readDraftVersion(threadKey: string, storage = getLocalStorage()): string | null {
  if (!storage || !threadKey) return null;
  try {
    return storage.getItem(composerVersionStorageKey(threadKey));
  } catch {
    return null;
  }
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
    return storage.getItem(composerNonceStorageKey(threadKey));
  } catch {
    return null;
  }
}

/** A null nonce clears it; writes are best-effort, like the draft itself. */
export function writeComposerRetryNonce(
  threadKey: string,
  nonce: string | null,
  storage: DraftStorage | null = getLocalStorage(),
): void {
  if (!storage || !threadKey) return;
  try {
    if (nonce === null) storage.removeItem(composerNonceStorageKey(threadKey));
    else storage.setItem(composerNonceStorageKey(threadKey), nonce);
  } catch {
    // The in-memory nonce still covers the retry while this chat stays open.
  }
}

export function composerDraftBindingRecord(
  text: string,
  bindings: readonly ComposerMentionBinding[],
): string | null {
  const canonical = text ? validateComposerMentionBindings(text, bindings) : [];
  return canonical.length ? JSON.stringify({ version: 1, text, bindings: canonical }) : null;
}

/** True when a composer's live text and bindings match an accepted draft notification. */
export function matchesAcceptedComposerDraft(
  current: { text: string; bindings: readonly ComposerMentionBinding[] },
  acceptedText: string,
  acceptedBindingRecord: string | null,
): boolean {
  return (
    current.text === acceptedText &&
    composerDraftBindingRecord(current.text, current.bindings) === acceptedBindingRecord
  );
}

function readBindingRecord(threadKey: string, storage = getLocalStorage()): string | null {
  try {
    return storage?.getItem(composerDraftBindingsKey(threadKey)) ?? null;
  } catch {
    return null;
  }
}

function readCanonicalBindingRecord(
  threadKey: string,
  text: string,
  storage = getLocalStorage(),
): string | null {
  if (!storage || !threadKey || !text) return null;
  const raw = readBindingRecord(threadKey, storage);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    if (record?.version !== 1 || record.text !== text) return null;
    return composerDraftBindingRecord(text, record.bindings);
  } catch {
    return null;
  }
}

/** Bindings are optional metadata; a stale record must never replace the raw text. */
export function readComposerDraftBindings(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): ComposerMentionBinding[] {
  if (!storage || !threadKey) return [];
  const key = composerDraftBindingsKey(threadKey);
  try {
    const raw = readBindingRecord(threadKey, storage);
    if (!raw) return [];
    const record = JSON.parse(raw);
    const text = readComposerDraft(threadKey, storage);
    if (record?.version !== 1 || record.text !== text) {
      storage.removeItem(key);
      return [];
    }
    return validateComposerMentionBindings(text, record.bindings);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* The in-memory draft remains usable. */
    }
    return [];
  }
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
): void {
  pendingSubmissions.delete(threadKey);
  if (threadKey) draftRevisions.set(threadKey, (draftRevisions.get(threadKey) ?? 0) + 1);
  if (!storage || !threadKey) return;
  try {
    // Plain-text callers preserve bindings only when they are resubmitting the
    // unchanged draft. New text without bindings cannot inherit old identities,
    // and a changed draft no longer matches the nonce its predecessor left.
    if (bindings !== undefined || draft !== readComposerDraft(threadKey, storage) || !draft) {
      storage.removeItem(composerDraftBindingsKey(threadKey));
      storage.removeItem(composerNonceStorageKey(threadKey));
    }
    if (draft.length === 0) {
      storage.removeItem(composerDraftStorageKey(threadKey));
      storage.removeItem(composerVersionStorageKey(threadKey));
    } else {
      storage.setItem(composerDraftStorageKey(threadKey), draft);
      storage.setItem(composerVersionStorageKey(threadKey), newClientId());
    }
    const record = bindings ? composerDraftBindingRecord(draft, bindings) : null;
    if (record) {
      storage.setItem(composerDraftBindingsKey(threadKey), record);
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
