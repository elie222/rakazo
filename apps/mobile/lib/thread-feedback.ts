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
};

export type SendAttempt = {
  payload: SendPayload;
  clientNonce: string;
  artifactIds: Map<string, string>;
  state: "queued" | "pending" | "failed" | "refused";
  acceptedSeq?: number;
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
  if (plan.shouldRunRoutines) {
    await Promise.all(
      plan.routineIds.map((routineId) =>
        request("routines/testRun", {
          routineId,
          clientNonce: `routine-mention:${attempt.clientNonce}:${routineId}`,
        }),
      ),
    );
  }
  if (!plan.shouldSend) return undefined;
  const artifactIds: string[] = [];
  for (const [index, pending] of attachments.entries()) {
    let id = attempt.artifactIds.get(pending.id);
    if (!id) {
      const artifact = await request(
        "artifacts/create",
        {
          ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
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
  const sent = await request("threads/send", {
    ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
    clientNonce: attempt.clientNonce,
    imageHandling: attempt.imageHandling ?? "confirm",
    text: plan.trimmed || undefined,
    mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
    artifactIds: artifactIds.length ? artifactIds : undefined,
    replyToMessageId: reroutedToGroup ? undefined : payload.replyTargetId,
    replyQuote: reroutedToGroup ? undefined : (payload.replyQuote ?? undefined),
  });
  return sent.seq;
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
  disk: UnsentDisk;
  errorText(error: unknown): string;
  notDelivered(attempt: SendAttempt): void;
};
let config: Config | undefined;
let unsentSends: SendAttempt[] = [];
let sessionCount = 0;
let restored = false;
let running: Promise<void> | undefined;
/** A retry that arrived while a drain was in progress, run once that drain stops. */
let pendingForce: boolean | null = null;
const watchers = new Set<() => void>();
const deliveredListeners = new Set<(attempt: SendAttempt) => void>();
const echoes = new Map<string, Set<number>>();
const screens = new Map<string, number>();
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
function changed() {
  unsentSends = [...unsentSends];
  if (restored) config?.disk.save(unsentSends.filter((a) => a.acceptedSeq === undefined));
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
function remove(attempt: SendAttempt) {
  config?.disk.forget(attempt);
  unsentSends = unsentSends.filter((a) => a !== attempt);
  changed();
}
export function configureUnsentSends(next: Config) {
  config = next;
}
export function restoreUnsentSends() {
  const scope = config?.scope();
  if (restored || !scope || !config) return;
  // Restore before the first write; repeated preparation cannot duplicate nonces.
  unsentSends = config.disk.load(sessionCount, scope);
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
  echoes.clear();
  pendingForce = null;
  config?.disk.clear();
  changed();
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
        try {
          const request = ((proc: RpcPath, body?: unknown, options?: RpcOptions) => {
            if (!inScope(attempt)) throw new Error("Session changed");
            return config!.request(proc, body, options, attempt.spaceId);
          }) as typeof rpc;
          await config.disk.hydrate(attempt);
          const seq = await deliverSend(attempt.payload, attempt, request);
          if (!inScope(attempt)) continue;
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
          if (!inScope(attempt)) continue;
          const detail = error as { status?: number; cause?: { status?: number } } | null;
          const status = detail?.status;
          const offline = isServerUnreachable(error) || (status ?? detail?.cause?.status) === 429;
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
      if (!scope) throw new Error("SESSION_CHANGED");
      if (unsentSends.filter((a) => a.acceptedSeq === undefined).length >= OUTBOX_MAX_ENTRIES)
        throw new Error(t("Too many unsent messages"));
      const attempt: SendAttempt = {
        payload: { ...payload, attachments: payload.attachments.map((a) => ({ ...a })) },
        clientNonce: newNonce(),
        artifactIds: new Map(),
        state: "queued",
        session: sessionCount,
        ...scope,
      };
      if (!config!.disk.admit(attempt)) throw new Error(t("Too many unsent messages"));
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
