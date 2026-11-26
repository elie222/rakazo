import type { ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import type { resolveComposerSendPlan } from "@rakazo/core";
import { foldPeerReplies } from "@rakazo/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComposerDraftSnapshot } from "./composer-draft";

/** A text send shown in its chat before its stored message arrives. */
export type PendingSend = {
  /** The bot or group id the send went to. */
  threadKey: string;
  clientNonce: string;
  text: string;
  /** The chat's newest message seq when the send began. */
  afterSeq: number;
  /** The message seq the server returned; the stored message carries it. */
  acceptedSeq?: number;
  replyToMessageId?: string;
  replyQuote?: string;
  /** Present when the send failed after the user edited their draft and stays in chat to retry. */
  error?: string;
};

const PENDING_ID_PREFIX = "pending:";

export function isPendingSendMessage(message: Pick<ThreadMessage, "id">) {
  return message.id.startsWith(PENDING_ID_PREFIX);
}

export function pendingSendNonce(message: Pick<ThreadMessage, "id">): string | null {
  return isPendingSendMessage(message) ? message.id.slice(PENDING_ID_PREFIX.length) : null;
}

function messageText(message: ThreadMessage) {
  return message.blocks
    .map((block) => (block.kind === "text" ? block.text : ""))
    .join("")
    .trim();
}

/** Rows built from live events carry an event seq, or none, rather than a message seq. */
const LIVE_ROW_PREFIXES = ["progress:", "subagent:", PENDING_ID_PREFIX];

/** The newest stored message seq in a chat, the baseline a pending send compares against. */
export function newestMessageSeq(messages: readonly ThreadMessage[]) {
  return messages.reduce(
    (max, message) =>
      Number.isFinite(message.seq) &&
      !LIVE_ROW_PREFIXES.some((prefix) => message.id.startsWith(prefix))
        ? Math.max(max, message.seq)
        : max,
    0,
  );
}

/** A direct chat stores the user's messages without an author; a group names who sent them. */
function sentBy(message: ThreadMessage, meId: string | undefined) {
  return message.role === "user" && (!message.author || message.author.id === meId);
}

/**
 * Pairs each pending send with its stored message, one message per send: by the seq the server
 * returned, or, while that answer is still on its way, by the same words from this user after the
 * send began (a live update can deliver the stored message before the send call returns).
 */
function unmatchedSends(
  messages: readonly ThreadMessage[],
  pending: readonly PendingSend[],
  meId: string | undefined,
) {
  const claimed = new Set<string>();
  const claim = (matches: (message: ThreadMessage) => boolean) => {
    const message = messages.find((candidate) => !claimed.has(candidate.id) && matches(candidate));
    if (message) claimed.add(message.id);
    return Boolean(message);
  };
  const confirmed = new Set(
    pending.filter(
      (send) =>
        send.acceptedSeq !== undefined && claim((message) => message.seq === send.acceptedSeq),
    ),
  );
  return pending.filter(
    (send) =>
      !confirmed.has(send) &&
      (send.acceptedSeq !== undefined ||
        send.error !== undefined ||
        !claim(
          (message) =>
            message.seq > send.afterSeq &&
            sentBy(message, meId) &&
            messageText(message) === send.text,
        )),
  );
}

/** The chat's messages with its pending sends shown last, each until its stored message arrives. */
export function withPendingSends(
  messages: ThreadMessage[],
  pending: readonly PendingSend[],
  threadKey: string | undefined,
  threadId: string | undefined,
  meId: string | undefined,
): ThreadMessage[] {
  const inChat = pending.filter((send) => send.threadKey === threadKey);
  if (!inChat.length || !threadId) return messages;
  const unmatched = unmatchedSends(messages, inChat, meId);
  if (!unmatched.length) return messages;
  let seq = newestMessageSeq(messages);
  const createdAt = new Date().toISOString();
  return [
    ...messages,
    ...unmatched.map((send) => ({
      id: `${PENDING_ID_PREFIX}${send.clientNonce}`,
      threadId,
      seq: ++seq,
      role: "user" as const,
      blocks: [{ kind: "text" as const, text: send.text }],
      ...(send.replyToMessageId ? { replyToMessageId: send.replyToMessageId } : {}),
      ...(send.replyQuote ? { replyQuote: send.replyQuote } : {}),
      createdAt,
    })),
  ];
}

/**
 * Pending sends without those the chat has caught up with: once it holds a message at or past a
 * send's stored seq, the stored message is in it or in older history it has not loaded.
 * Failed sends stay retryable until retried (which deduplicates on `clientNonce`) or dismissed,
 * because text matching cannot tell a failed reply apart from another send with the same words.
 */
export function withoutDeliveredSends(
  pending: PendingSend[],
  messages: readonly ThreadMessage[],
  threadKey: string | undefined,
) {
  const newest = newestMessageSeq(messages);
  const next = pending.filter(
    (send) =>
      send.threadKey !== threadKey || send.acceptedSeq === undefined || newest < send.acceptedSeq,
  );
  return next.length === pending.length ? pending : next;
}

export type PendingRetryPayload = {
  groupTarget?: string;
  botTarget?: string;
  mentions: ReturnType<typeof resolveComposerSendPlan>["mentionPayload"];
  routineIds?: string[];
  fromPage?: boolean;
  replyTarget: ThreadMessage | null;
  replyQuote: string | null;
  submittedDraft: ComposerDraftSnapshot | null;
};

export type StoredFailedSend = {
  send: PendingSend;
  payload: PendingRetryPayload;
};

export type StoredFailedSendEvent =
  | { kind: "sync" }
  | {
      kind: "accepted";
      clientNonce: string;
      threadKey: string;
      isGroup: boolean;
      acceptedSeq?: number;
      source?: object;
    };

export type FailedSendWriteToken = {
  scopeKey: string | null;
  threadKey: string;
  storeGeneration: number;
  threadGeneration: number;
};

type StoredFailedSendListener = (event: StoredFailedSendEvent) => void;

const failedSendsByScope = new Map<string, Map<string, StoredFailedSend>>();
const failedSendListeners = new Map<string, Set<StoredFailedSendListener>>();
const threadDeletionGenerations = new Map<string, number>();
let storeGeneration = 0;
let activeFailedSendUserId: string | null = null;

function threadGenerationKey(scopeKey: string | null, threadKey: string): string {
  return `${scopeKey ?? ""}\0${threadKey}`;
}

function notifyFailedSendScope(
  scopeKey: string,
  event: StoredFailedSendEvent = { kind: "sync" },
): void {
  const listeners = failedSendListeners.get(scopeKey);
  if (!listeners) return;
  for (const listener of [...listeners]) listener(event);
}

export function failedSendScopeKey(
  userId: string | undefined,
  spaceId: string | undefined,
): string | null {
  return userId && spaceId ? `${userId}:${spaceId}` : null;
}

export function subscribeStoredFailedSends(
  scopeKey: string,
  listener: StoredFailedSendListener,
): () => void {
  let listeners = failedSendListeners.get(scopeKey);
  if (!listeners) {
    listeners = new Set();
    failedSendListeners.set(scopeKey, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) failedSendListeners.delete(scopeKey);
  };
}

export function captureFailedSendWriteToken(
  scopeKey: string | null,
  threadKey: string,
): FailedSendWriteToken {
  return {
    scopeKey,
    threadKey,
    storeGeneration,
    threadGeneration: threadDeletionGenerations.get(threadGenerationKey(scopeKey, threadKey)) ?? 0,
  };
}

export function isFailedSendWriteValid(
  token: FailedSendWriteToken,
  currentScopeKey: string | null = token.scopeKey,
): boolean {
  if (token.storeGeneration !== storeGeneration) return false;
  const baseGeneration =
    threadDeletionGenerations.get(threadGenerationKey(token.scopeKey, token.threadKey)) ?? 0;
  if (baseGeneration !== token.threadGeneration) return false;
  if (currentScopeKey !== token.scopeKey) {
    const currentGeneration =
      threadDeletionGenerations.get(threadGenerationKey(currentScopeKey, token.threadKey)) ?? 0;
    if (currentGeneration !== 0) return false;
  }
  return true;
}

export function readStoredFailedSends(scopeKey: string): StoredFailedSend[] {
  const entries = failedSendsByScope.get(scopeKey);
  return entries ? Array.from(entries.values()) : [];
}

export function saveStoredFailedSend(
  scopeKey: string,
  send: PendingSend,
  payload: PendingRetryPayload,
  writeToken?: FailedSendWriteToken,
): boolean {
  if (writeToken && !isFailedSendWriteValid(writeToken, scopeKey)) return false;
  let entries = failedSendsByScope.get(scopeKey);
  if (!entries) {
    entries = new Map();
    failedSendsByScope.set(scopeKey, entries);
  }
  entries.set(send.clientNonce, { send, payload });
  notifyFailedSendScope(scopeKey);
  return true;
}

/** Updates an existing failed row on retry failure; ignores rows already dismissed or delivered. */
export function updateStoredFailedSend(
  scopeKey: string,
  send: PendingSend,
  payload: PendingRetryPayload,
  writeToken?: FailedSendWriteToken,
): boolean {
  if (writeToken && !isFailedSendWriteValid(writeToken, scopeKey)) return false;
  const entries = failedSendsByScope.get(scopeKey);
  if (!entries?.has(send.clientNonce)) return false;
  entries.set(send.clientNonce, { send, payload });
  notifyFailedSendScope(scopeKey);
  return true;
}

export function deleteStoredFailedSend(
  scopeKey: string,
  clientNonce: string,
  accepted?: { threadKey: string; isGroup: boolean; acceptedSeq?: number; source?: object },
): void {
  const entries = failedSendsByScope.get(scopeKey);
  const removed = entries?.delete(clientNonce) ?? false;
  if (entries && entries.size === 0) failedSendsByScope.delete(scopeKey);
  if (accepted) {
    notifyFailedSendScope(scopeKey, { kind: "accepted", clientNonce, ...accepted });
  } else if (removed) {
    notifyFailedSendScope(scopeKey);
  }
}

export function deleteStoredFailedSendsForThread(scopeKey: string | null, threadKey: string): void {
  const genKey = threadGenerationKey(scopeKey, threadKey);
  threadDeletionGenerations.set(genKey, (threadDeletionGenerations.get(genKey) ?? 0) + 1);
  if (!scopeKey) return;
  const entries = failedSendsByScope.get(scopeKey);
  if (!entries) return;
  let removed = false;
  for (const [nonce, entry] of entries) {
    if (entry.send.threadKey === threadKey) {
      entries.delete(nonce);
      removed = true;
    }
  }
  if (entries.size === 0) failedSendsByScope.delete(scopeKey);
  if (removed) notifyFailedSendScope(scopeKey);
}

export function pruneOtherUserFailedSends(userId: string): void {
  const userChanged = activeFailedSendUserId !== null && activeFailedSendUserId !== userId;
  activeFailedSendUserId = userId;
  if (userChanged) {
    storeGeneration += 1;
    threadDeletionGenerations.clear();
  }
  const prefix = `${userId}:`;
  for (const scopeKey of [...failedSendsByScope.keys()]) {
    if (!scopeKey.startsWith(prefix)) {
      failedSendsByScope.delete(scopeKey);
      notifyFailedSendScope(scopeKey);
    }
  }
}

export function hasStoredFailedSends(): boolean {
  return failedSendsByScope.size > 0;
}

export function clearStoredFailedSends(): void {
  storeGeneration += 1;
  activeFailedSendUserId = null;
  threadDeletionGenerations.clear();
  failedSendsByScope.clear();
  for (const scopeKey of [...failedSendListeners.keys()]) notifyFailedSendScope(scopeKey);
}

/** Updates a pending send once the server accepts it, removing it when no seq was returned. */
export function applyAcceptedPendingSend(
  current: PendingSend[],
  clientNonce: string,
  acceptedSeq: number | undefined,
): PendingSend[] {
  return acceptedSeq === undefined
    ? current.filter((pending) => pending.clientNonce !== clientNonce)
    : current.map((pending) =>
        pending.clientNonce === clientNonce
          ? { ...pending, acceptedSeq, error: undefined }
          : pending,
      );
}

/** Reconciles a shell's local pending sends with the scoped store's current failed rows. */
export function reconcileStoredFailedSends(
  current: PendingSend[],
  stored: readonly StoredFailedSend[],
): PendingSend[] {
  const storedByNonce = new Map(stored.map((entry) => [entry.send.clientNonce, entry.send]));
  let changed = false;
  const seen = new Set<string>();
  const next: PendingSend[] = [];
  for (const send of current) {
    seen.add(send.clientNonce);
    if (send.error === undefined) {
      next.push(send);
      continue;
    }
    const latest = storedByNonce.get(send.clientNonce);
    if (!latest) {
      changed = true;
      continue;
    }
    if (latest !== send) changed = true;
    next.push(latest);
  }
  for (const entry of stored) {
    if (seen.has(entry.send.clientNonce)) continue;
    changed = true;
    next.push(entry.send);
  }
  return changed ? next : current;
}

/** Owns the shell's optimistic/failed text sends and keeps them synced with the scoped store. */
export function usePendingSendStore({
  userId,
  spaceId,
  activeThreadKey,
  activeSnapshot,
  onRemoteAccepted,
  onDiscardPayload,
}: {
  userId: string | undefined;
  spaceId: string | undefined;
  activeThreadKey: string | undefined;
  activeSnapshot: ThreadSnapshot | null;
  onRemoteAccepted: (threadKey: string, isGroup: boolean, clientNonce: string) => void;
  onDiscardPayload?: (clientNonce: string, payload?: PendingRetryPayload) => void;
}) {
  const failedSendScope = failedSendScopeKey(userId, spaceId);
  const failedSendScopeRef = useRef(failedSendScope);
  failedSendScopeRef.current = failedSendScope;
  const storeSourceRef = useRef({});
  const onRemoteAcceptedRef = useRef(onRemoteAccepted);
  onRemoteAcceptedRef.current = onRemoteAccepted;
  const onDiscardPayloadRef = useRef(onDiscardPayload);
  onDiscardPayloadRef.current = onDiscardPayload;
  const [pendingSends, setPendingSends] = useState<PendingSend[]>(() =>
    failedSendScope ? readStoredFailedSends(failedSendScope).map((entry) => entry.send) : [],
  );
  const pendingSendsRef = useRef(pendingSends);
  pendingSendsRef.current = pendingSends;
  const pendingRetryPayloads = useRef<Map<string, PendingRetryPayload> | null>(null);
  if (pendingRetryPayloads.current === null) {
    pendingRetryPayloads.current = new Map(
      failedSendScope
        ? readStoredFailedSends(failedSendScope).map((entry) => [
            entry.send.clientNonce,
            entry.payload,
          ])
        : [],
    );
  }
  const syncStoredFailedSends = useCallback((stored: readonly StoredFailedSend[]) => {
    setPendingSends((current) => {
      const next = reconcileStoredFailedSends(current, stored);
      const payloads = pendingRetryPayloads.current!;
      const kept = new Set(next.map((send) => send.clientNonce));
      for (const entry of stored) payloads.set(entry.send.clientNonce, entry.payload);
      for (const nonce of payloads.keys()) {
        if (!kept.has(nonce)) payloads.delete(nonce);
      }
      return next;
    });
  }, []);
  useEffect(() => {
    if (userId) pruneOtherUserFailedSends(userId);
    if (!failedSendScope) {
      syncStoredFailedSends([]);
      return;
    }
    syncStoredFailedSends(readStoredFailedSends(failedSendScope));
    return subscribeStoredFailedSends(failedSendScope, (event) => {
      if (event.kind === "accepted") {
        pendingRetryPayloads.current!.delete(event.clientNonce);
        setPendingSends((current) =>
          applyAcceptedPendingSend(current, event.clientNonce, event.acceptedSeq),
        );
        if (event.source !== storeSourceRef.current) {
          onRemoteAcceptedRef.current(event.threadKey, event.isGroup, event.clientNonce);
        }
        return;
      }
      syncStoredFailedSends(readStoredFailedSends(failedSendScope));
    });
  }, [userId, failedSendScope, syncStoredFailedSends]);
  const activeMessages = activeSnapshot?.messages;
  // A send stays shown until the chat holds its stored message, whichever update brings it;
  // a seq that lands after its message arrived is checked against the messages already here.
  useEffect(() => {
    if (!activeMessages) return;
    setPendingSends((current) => {
      const next = withoutDeliveredSends(current, activeMessages, activeThreadKey);
      if (next !== current) {
        const kept = new Set(next.map((send) => send.clientNonce));
        const payloads = pendingRetryPayloads.current!;
        for (const nonce of payloads.keys()) {
          if (!kept.has(nonce)) {
            payloads.delete(nonce);
            if (failedSendScopeRef.current)
              deleteStoredFailedSend(failedSendScopeRef.current, nonce);
          }
        }
      }
      return next;
    });
  }, [activeMessages, activeThreadKey, pendingSends]);
  // The open chat's transcript with its unconfirmed text sends shown last, or null with none.
  const pendingTranscript = useMemo(() => {
    if (!pendingSends.length || !activeSnapshot) return null;
    const { messages, threadId } = activeSnapshot;
    const shown = withPendingSends(messages, pendingSends, activeThreadKey, threadId, userId);
    return shown === messages ? null : foldPeerReplies(shown, { includePeerReceipts: true });
  }, [activeSnapshot, activeThreadKey, userId, pendingSends]);
  const failedPendingSends = useMemo(() => {
    const failed = new Map<string, string>();
    for (const send of pendingSends) {
      if (send.threadKey === activeThreadKey && send.error !== undefined) {
        failed.set(send.clientNonce, send.error);
      }
    }
    return failed.size > 0 ? failed : undefined;
  }, [activeThreadKey, pendingSends]);
  const hasFailedSends = useMemo(
    () => pendingSends.some((send) => send.error !== undefined),
    [pendingSends],
  );
  const hasFailedSend = useCallback(
    (clientNonce: string) => pendingRetryPayloads.current!.has(clientNonce),
    [],
  );
  const restorePendingSend = useCallback((clientNonce: string) => {
    pendingRetryPayloads.current!.delete(clientNonce);
    if (failedSendScopeRef.current) deleteStoredFailedSend(failedSendScopeRef.current, clientNonce);
    setPendingSends((current) => current.filter((pending) => pending.clientNonce !== clientNonce));
  }, []);
  const discardPendingSend = useCallback(
    (clientNonce: string) => {
      const retry = pendingRetryPayloads.current!.get(clientNonce);
      restorePendingSend(clientNonce);
      onDiscardPayloadRef.current?.(clientNonce, retry);
    },
    [restorePendingSend],
  );
  const clearThreadPendingSends = useCallback((threadKey: string) => {
    setPendingSends((current) => {
      const next = current.filter((send) => send.threadKey !== threadKey);
      if (next.length === current.length) return current;
      const kept = new Set(next.map((send) => send.clientNonce));
      const payloads = pendingRetryPayloads.current!;
      for (const nonce of payloads.keys()) {
        if (!kept.has(nonce)) payloads.delete(nonce);
      }
      return next;
    });
    deleteStoredFailedSendsForThread(failedSendScopeRef.current, threadKey);
  }, []);

  return {
    failedSendScopeRef,
    storeSourceRef,
    pendingSends,
    setPendingSends,
    pendingSendsRef,
    pendingRetryPayloads,
    pendingTranscript,
    failedPendingSends,
    hasFailedSends,
    hasFailedSend,
    restorePendingSend,
    discardPendingSend,
    clearThreadPendingSends,
  };
}
