import type { AgentSkillCatalogEntry, RpcPath } from "@rakazo/contracts";
import type { ComposerMention, resolveComposerSendPlan } from "@rakazo/core";
import {
  isImageInputConfirmation,
  isModelRequiredSendError,
  isServerUnreachable,
} from "@rakazo/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RpcOptions, rpc } from "./api";
import { t } from "./i18n";
import type { PickedAttachment } from "./pick-attachments";

export type ComposerSnapshot = {
  promptText: string;
  mentions: ComposerMention[];
  skill: AgentSkillCatalogEntry | null;
  replyTargetId?: string;
  replyQuote: string | null;
  attachmentIds: string[];
};

export function settleComposer(submitted: ComposerSnapshot, current: ComposerSnapshot) {
  return {
    clearComposer: JSON.stringify(current) === JSON.stringify(submitted),
  };
}

export type SendPayload = {
  originThreadKey: string;
  displayText: string;
  replyPreview: string | null;
  initialBotTarget?: string;
  botTarget?: string;
  groupTarget?: string;
  reroutedToGroup: boolean;
  plan: ReturnType<typeof resolveComposerSendPlan>;
  attachments: PickedAttachment[];
  replyTargetId?: string;
  replyQuote: string | null;
  /** A reply to a page's card, sent from the page: it quotes nothing. */
  fromPage?: true;
};

export type SendAttempt = {
  payload: SendPayload;
  clientNonce: string;
  artifactIds: Map<string, string>;
  state: "queued" | "pending" | "failed" | "refused";
  acceptedSeq?: number;
  /** The run the accepted send started, shown as queued until the thread reports it. */
  acceptedRun?: { runId: string; taskId: string };
  apiBase: string;
  spaceId: string | null;
  userId: string;
  cacheSession: string;
  /** The signed-in session the attempt began in; a failure after sign-out is dropped. */
  session: number;
  error?: string;
  imageConfirmation?: boolean;
  imageHandling?: "file";
};

const UPLOAD_TIMEOUT_MS = 60_000;

export async function deliverSend(
  payload: SendPayload,
  attempt: SendAttempt,
  request: typeof rpc,
): Promise<number | undefined> {
  const { plan, groupTarget, botTarget, reroutedToGroup, attachments } = payload;
  const target = groupTarget ? { groupId: groupTarget } : { botId: botTarget! };
  if (!plan.shouldSend) {
    if (plan.shouldRunRoutines)
      await request("threads/sendWithRoutines", {
        ...target,
        clientNonce: attempt.clientNonce,
        routineIds: plan.routineIds,
      });
    return undefined;
  }
  const artifactIds: string[] = [];
  for (const [index, pending] of attachments.entries()) {
    let id = attempt.artifactIds.get(pending.id);
    if (!id) {
      const artifact = await request(
        "artifacts/create",
        {
          ...target,
          name: pending.name,
          mimeType: pending.mimeType,
          contentBase64: pending.contentBase64,
          clientNonce: `${attempt.clientNonce}:${index}`,
        },
        { timeoutMs: UPLOAD_TIMEOUT_MS },
      );
      id = artifact.id;
      attempt.artifactIds.set(pending.id, id);
    }
    artifactIds.push(id);
  }
  const message = {
    ...target,
    clientNonce: attempt.clientNonce,
    imageHandling: attempt.imageHandling ?? "confirm",
    text: plan.trimmed || undefined,
    mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
    artifactIds: artifactIds.length ? artifactIds : undefined,
    replyToMessageId: reroutedToGroup ? undefined : payload.replyTargetId,
    replyQuote: reroutedToGroup ? undefined : (payload.replyQuote ?? undefined),
    fromPage: reroutedToGroup ? undefined : payload.fromPage,
  } as const;
  // The routines run in the same server operation as the message: both or neither.
  const sent = plan.shouldRunRoutines
    ? (await request("threads/sendWithRoutines", { ...message, routineIds: plan.routineIds })).send
    : undefined;
  // Runs already saved for this nonce return no message; the plain send saves or replays it.
  const accepted = sent ?? (await request("threads/send", message));
  attempt.acceptedRun = { runId: accepted.runId, taskId: accepted.taskId };
  return accepted.seq;
}

export type OutboxScope = Pick<SendAttempt, "apiBase" | "spaceId" | "userId" | "cacheSession">;
export type UnsentDisk = {
  admit(attempt: SendAttempt): boolean;
  hydrate(attempt: SendAttempt): Promise<void>;
  forget(attempt: SendAttempt): void;
  save(attempts: SendAttempt[]): void;
  load(session: number, scope: OutboxScope): SendAttempt[];
  clear(): void;
};
type Config = {
  request(
    proc: RpcPath,
    body: unknown,
    options: RpcOptions | undefined,
    spaceId: string | null,
  ): Promise<unknown>;
  scope(): OutboxScope | null;
  serverReachable(): boolean;
  /** True while a password change may have revoked the session before replacing it. */
  passwordChanging(): boolean;
  disk: UnsentDisk;
  errorText(error: unknown): string;
  notDelivered(attempt: SendAttempt): void;
};
let config: Config | undefined;
let unsentSends: SendAttempt[] = [];
let sessionCount = 0;
let restored = false;
let diskReadable = true;
const memoryOnly = new WeakSet<SendAttempt>();
/** Memory-only sends whose files were already written; the next save lists them again. */
const writtenFiles = new WeakSet<SendAttempt>();
/** Memory-only sends that may have files no index lists: a failed admission or deletion left them. */
const unlistedFiles = new WeakSet<SendAttempt>();
/** True when the next index save lists the send: it was never memory-only, or its files are written. */
function isListed(attempt: SendAttempt) {
  return !memoryOnly.has(attempt) || writtenFiles.has(attempt);
}
let running: Promise<void> | undefined;
/** A retry that arrived while a drain was in progress, run once that drain stops. */
let pendingForce: boolean | null = null;
const watchers = new Set<() => void>();
const deliveredListeners = new Set<(attempt: SendAttempt) => void>();
const echoes = new Map<string, Set<number>>();
const screens = new Map<string, number>();
/** Removed sends whose files wait for a saved index that no longer lists them. */
const removed = new Set<SendAttempt>();
export const OUTBOX_MAX_ENTRIES = 20;

function subscribe(watcher: () => void) {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}
function getUnsentSends() {
  return unsentSends;
}
function waiting() {
  return unsentSends.filter((a) => a.acceptedSeq === undefined);
}
/** A clear that failed: discarded messages may still be on disk, so nothing is saved next to them. */
let clearPending = false;
function tryDisk<T>(operation: () => T, fallback: T): T {
  try {
    return operation();
  } catch (error) {
    console.warn("Outbox storage unavailable", error);
    return fallback;
  }
}
function finishPendingClear() {
  if (clearPending) {
    clearPending = !tryDisk(() => {
      config!.disk.clear();
      return true;
    }, false);
  }
  return !clearPending;
}
/**
 * Admission clears the attachment bytes on the attempt it writes. Handing it a copy with
 * detached attachments writes the same files while the objects a running delivery captured
 * keep their bytes; nothing holds the copy once admission returns.
 */
function detachedForAdmission(attempt: SendAttempt): SendAttempt {
  return {
    ...attempt,
    payload: {
      ...attempt.payload,
      attachments: attempt.payload.attachments.map((attachment) => ({ ...attachment })),
    },
  };
}

/** Admits a detached copy; the live attachments take its file previews but keep their bytes. */
function admitCopy(attempt: SendAttempt) {
  const copy = detachedForAdmission(attempt);
  if (!config!.disk.admit(copy)) return false;
  copy.payload.attachments.forEach((admitted, index) => {
    attempt.payload.attachments[index]!.previewUri = admitted.previewUri;
  });
  return true;
}

/** Admits a memory-only send again, first deleting files no index lists if they block it. */
function admitAgain(attempt: SendAttempt, attempts: SendAttempt[]) {
  if (admitCopy(attempt)) return true;
  if (!unlistedFiles.has(attempt)) return false;
  // The folder belongs to another send with this nonce whose files are listed or written.
  const owned = [...attempts, ...unsentSends].some(
    (other) => other !== attempt && other.clientNonce === attempt.clientNonce && isListed(other),
  );
  if (owned) return false;
  config!.disk.forget(attempt);
  return admitCopy(attempt);
}

/** Saves the index, then deletes files only once it no longer lists them. */
function save(attempts: SendAttempt[]) {
  return tryDisk(() => {
    if (!finishPendingClear() || !diskReadable) return false;
    // A write error left these in memory only. Ones whose files were written join this index
    // directly; the others admit again on a detached copy, and a successful admission is
    // recorded at once, so a later save lists it rather than re-admitting over its own
    // files. What still cannot reach disk waits for a later save without blocking the others.
    for (const attempt of attempts) {
      if (isListed(attempt)) continue;
      const admitted = tryDisk(() => admitAgain(attempt, attempts), undefined);
      if (admitted) {
        writtenFiles.add(attempt);
        unlistedFiles.delete(attempt);
      } else if (admitted === undefined) unlistedFiles.add(attempt);
    }
    const listed = attempts.filter(isListed);
    config!.disk.save(listed);
    // Only now does the index on disk list them; until it does, memory stays their only copy.
    // A running delivery keeps the bytes it captured until it finishes; the rest read from disk.
    for (const attempt of listed) {
      if (!memoryOnly.has(attempt)) continue;
      memoryOnly.delete(attempt);
      writtenFiles.delete(attempt);
      removed.delete(attempt);
      if (attempt.state !== "pending")
        for (const attachment of attempt.payload.attachments) attachment.contentBase64 = "";
    }
    for (const attempt of removed) {
      removed.delete(attempt);
      if (listed.some((a) => a.clientNonce === attempt.clientNonce)) continue;
      config!.disk.forget(attempt);
      // Sent again, it keeps its bytes in memory until a new admission and index save succeed.
      writtenFiles.delete(attempt);
      unlistedFiles.add(attempt);
    }
    return true;
  }, false);
}
function changed() {
  unsentSends = [...unsentSends];
  if (restored && config) save(waiting());
  for (const watcher of watchers) watcher();
}
function inScope(attempt: SendAttempt) {
  const scope = config?.scope();
  return (
    !!scope &&
    attempt.session === sessionCount &&
    attempt.apiBase === scope.apiBase &&
    attempt.userId === scope.userId &&
    attempt.cacheSession === scope.cacheSession
  );
}
/**
 * A send that settled after the session changed. An account change already dropped it; after a
 * password change it waits, saved, for the drain under the new session.
 */
function requeue(attempt: SendAttempt) {
  if (!unsentSends.includes(attempt)) return;
  attempt.state = "queued";
  changed();
}
function remove(attempt: SendAttempt) {
  unsentSends = unsentSends.filter((a) => a !== attempt);
  // A saved index may still list the message, so its files go only after the index drops it.
  removed.add(attempt);
  changed();
}
export function configureUnsentSends(next: Config) {
  config = next;
}
export function restoreUnsentSends() {
  const scope = config?.scope();
  if (restored || !scope || !config) return;
  // Restore before the first write; repeated preparation cannot duplicate nonces.
  // Leave unread messages intact until a later launch can restore them.
  diskReadable = false;
  unsentSends =
    tryDisk(() => {
      const loaded = config!.disk.load(sessionCount, scope);
      diskReadable = true;
      return loaded;
    }, undefined) ?? [];
  for (const attempt of unsentSends) {
    if (attempt.state === "refused" && isModelRequiredSendError(attempt.error))
      attempt.state = "failed";
  }
  restored = true;
  changed();
}
export function clearUnsentSends() {
  sessionCount += 1;
  restored = false;
  unsentSends = [];
  removed.clear();
  echoes.clear();
  pendingForce = null;
  diskReadable = true;
  clearPending = !tryDisk(() => {
    config?.disk.clear();
    return true;
  }, false);
  // Never reload discarded messages while their deletion is pending.
  if (clearPending) restored = true;
  changed();
}
/** Messages still waiting to be delivered; an accepted one only waits for its echo. */
export function hasUnsentSends() {
  return waiting().length > 0;
}
/** False after a restore could not read the saved queue: an empty list then proves nothing. */
export function unsentSendsReadable() {
  return diskReadable;
}
// Alias kept for existing sign-out callers.
export const clearFailedSends = clearUnsentSends;
export function confirmEchoes(threadKey: string, seqs: Iterable<number>) {
  const seen = new Set(seqs);
  echoes.set(threadKey, seen);
  for (const attempt of unsentSends) {
    if (
      attempt.payload.originThreadKey === threadKey &&
      attempt.acceptedSeq !== undefined &&
      seen.has(attempt.acceptedSeq)
    )
      remove(attempt);
  }
}
export function subscribeDelivered(listener: (attempt: SendAttempt) => void) {
  deliveredListeners.add(listener);
  return () => {
    deliveredListeners.delete(listener);
  };
}
export function sendWaitingMessages(force = false): Promise<void> {
  if (running) {
    pendingForce = pendingForce === true || force;
    return running;
  }
  const task = (async () => {
    let nextForce = force;
    for (;;) {
      let allowUnreachable = nextForce;
      while (config && (allowUnreachable || config.serverReachable())) {
        allowUnreachable = false;
        const attempt = unsentSends.find((a) => a.state === "queued" && inScope(a));
        if (!attempt) break;
        attempt.state = "pending";
        changed();
        // A result from before a session change is stale even once the new scope is ready.
        const dispatched = config.scope();
        const stale = () => !inScope(attempt) || config?.scope() !== dispatched;
        try {
          const request = ((proc: RpcPath, body?: unknown, options?: RpcOptions) => {
            if (!inScope(attempt)) throw new Error("Session changed");
            return config!.request(proc, body, options, attempt.spaceId);
          }) as typeof rpc;
          if (!memoryOnly.has(attempt)) await config.disk.hydrate(attempt);
          const seq = await deliverSend(attempt.payload, attempt, request);
          // The retry under the new session gets the same seq back for the same nonce.
          if (stale()) {
            requeue(attempt);
            continue;
          }
          attempt.acceptedSeq = seq;
          for (const listener of deliveredListeners) listener(attempt);
          if (
            !screens.has(attempt.payload.originThreadKey) ||
            seq === undefined ||
            attempt.payload.reroutedToGroup ||
            echoes.get(attempt.payload.originThreadKey)?.has(seq)
          )
            remove(attempt);
          else changed();
        } catch (error) {
          if (stale()) {
            requeue(attempt);
            continue;
          }
          const detail = error as { status?: number; cause?: { status?: number } } | null;
          const status = detail?.status;
          const sendStatus = status ?? detail?.cause?.status;
          // A password change revokes the token before its replacement arrives; the send waits
          // for the new session. Any other 401 is refused as usual.
          const offline =
            isServerUnreachable(error) ||
            sendStatus === 429 ||
            (sendStatus === 401 && config.passwordChanging());
          attempt.state = offline
            ? "queued"
            : !isModelRequiredSendError(error) &&
                status &&
                status >= 400 &&
                status < 500 &&
                // A 409 or 426 clears once teaching stops or the app updates, so it stays retryable.
                ![408, 409, 425, 426, 429].includes(status)
              ? "refused"
              : "failed";
          attempt.imageConfirmation = isImageInputConfirmation(error);
          attempt.error = config.errorText(error);
          changed();
          if (offline) break;
          config.notDelivered(attempt);
        } finally {
          if (!memoryOnly.has(attempt))
            for (const attachment of attempt.payload.attachments) attachment.contentBase64 = "";
        }
      }
      if (pendingForce === null) return;
      nextForce = pendingForce;
      pendingForce = null;
    }
  })().finally(() => {
    if (running !== task) return;
    running = undefined;
    if (pendingForce === null) return;
    const next = pendingForce;
    pendingForce = null;
    void sendWaitingMessages(next);
  });
  running = task;
  return task;
}
/** `echoed` holds the seqs of the chat's user messages on screen; an echoed send hides in that render. */
export function useThreadFeedback(
  threadKey: string | undefined,
  newNonce: () => string,
  echoed?: ReadonlySet<number>,
) {
  const [error, setError] = useState<string | null>(null);
  const allSends = useSyncExternalStore(subscribe, getUnsentSends, getUnsentSends);
  const activeThread = useRef(threadKey);
  activeThread.current = threadKey;
  useEffect(() => setError(null), [threadKey]);
  useEffect(() => {
    if (!threadKey) return;
    screens.set(threadKey, (screens.get(threadKey) ?? 0) + 1);
    return () => {
      const remaining = (screens.get(threadKey) ?? 1) - 1;
      if (remaining) {
        screens.set(threadKey, remaining);
        return;
      }
      screens.delete(threadKey);
      echoes.delete(threadKey);
      for (const attempt of unsentSends) {
        if (attempt.payload.originThreadKey === threadKey && attempt.acceptedSeq !== undefined)
          remove(attempt);
      }
    };
  }, [threadKey]);
  useEffect(() => {
    if (threadKey && echoed) confirmEchoes(threadKey, echoed);
  }, [threadKey, echoed]);
  return {
    error,
    setError(value: string | null) {
      if (threadKey === activeThread.current) setError(value);
    },
    refreshed(key = threadKey) {
      if (key === activeThread.current) setError(null);
    },
    unsentSends: allSends.filter(
      (a) =>
        a.payload.originThreadKey === threadKey &&
        inScope(a) &&
        !(a.acceptedSeq !== undefined && echoed?.has(a.acceptedSeq)),
    ),
    sendAttempt(payload: SendPayload): SendAttempt {
      const scope = config?.scope();
      // Saving before the restore would replace the queue still on disk.
      if (!scope || !restored) throw new Error("SESSION_CHANGED");
      if (waiting().length >= OUTBOX_MAX_ENTRIES) throw new Error(t("Too many unsent messages"));
      // Files left by a removal whose save failed still count against the disk budget.
      if (removed.size) save(waiting());
      const attempt: SendAttempt = {
        payload: { ...payload, attachments: payload.attachments.map((a) => ({ ...a })) },
        clientNonce: newNonce(),
        artifactIds: new Map(),
        state: "queued",
        session: sessionCount,
        ...scope,
      };
      const canPersist = finishPendingClear() && diskReadable;
      const admitted = canPersist
        ? tryDisk(() => config!.disk.admit(attempt), undefined)
        : undefined;
      if (admitted === false) throw new Error(t("Too many unsent messages"));
      // Save before the caller clears the composer whenever storage is available.
      if (admitted === undefined || !save([...waiting(), attempt])) {
        // A failed move may have committed; forget files only after a later index omits them.
        removed.add(attempt);
        memoryOnly.add(attempt);
        if (admitted === true) writtenFiles.add(attempt);
        else unlistedFiles.add(attempt);
        // Bytes come back from the composer; written files keep their previews.
        attempt.payload.attachments = payload.attachments.map((a, index) =>
          admitted
            ? { ...a, previewUri: attempt.payload.attachments[index]!.previewUri }
            : { ...a },
        );
      }
      return attempt;
    },
    async send(attempt: SendAttempt, force = false) {
      if (!inScope(attempt) || attempt.state === "pending" || attempt.state === "refused")
        return false;
      if (!unsentSends.includes(attempt)) unsentSends.push(attempt);
      attempt.state = "queued";
      changed();
      await sendWaitingMessages(force);
      return inScope(attempt) && attempt.acceptedSeq !== undefined;
    },
    discard(attempt: SendAttempt) {
      if (attempt.state !== "pending") remove(attempt);
    },
  };
}
