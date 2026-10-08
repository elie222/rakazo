import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type { ComposerMention, resolveComposerSendPlan } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import type { rpc } from "./api";
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
  sending: boolean;
  error?: string;
};

export async function deliverSend(payload: SendPayload, attempt: SendAttempt, request: typeof rpc) {
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
  if (!plan.shouldSend) return;
  const artifactIds: string[] = [];
  for (const pending of attachments) {
    let id = attempt.artifactIds.get(pending.id);
    if (!id) {
      const artifact = await request<{ id: string }>("artifacts/create", {
        ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
        name: pending.name,
        mimeType: pending.mimeType,
        contentBase64: pending.contentBase64,
      });
      id = artifact.id;
      attempt.artifactIds.set(pending.id, id);
    }
    artifactIds.push(id);
  }
  await request("threads/send", {
    ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
    clientNonce: attempt.clientNonce,
    text: plan.trimmed || undefined,
    mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
    artifactIds: artifactIds.length ? artifactIds : undefined,
    replyToMessageId: reroutedToGroup ? undefined : payload.replyTargetId,
    replyQuote: reroutedToGroup ? undefined : (payload.replyQuote ?? undefined),
  });
}

export function useThreadFeedback(threadKey: string | undefined, newNonce: () => string) {
  const [error, setError] = useState<string | null>(null);
  const [failedSends, setFailedSends] = useState<SendAttempt[]>([]);
  const activeThread = useRef(threadKey);
  activeThread.current = threadKey;

  useEffect(() => setError(null), [threadKey]);

  return {
    error,
    setError(value: string | null) {
      if (threadKey === activeThread.current) setError(value);
    },
    refreshed(key = threadKey) {
      if (key === activeThread.current) setError(null);
    },
    failedSends: failedSends.filter((attempt) => attempt.payload.originThreadKey === threadKey),
    sendAttempt(payload: SendPayload): SendAttempt {
      return { payload, clientNonce: newNonce(), artifactIds: new Map(), sending: false };
    },
    start(attempt: SendAttempt) {
      if (attempt.sending) return false;
      attempt.sending = true;
      setFailedSends((current) => [...current]);
      return true;
    },
    sent(attempt: SendAttempt) {
      attempt.sending = false;
      setFailedSends((current) => current.filter((item) => item !== attempt));
    },
    sendFailed(attempt: SendAttempt) {
      attempt.sending = false;
      setFailedSends((current) =>
        current.includes(attempt) ? [...current] : [...current, attempt],
      );
    },
    discard(attempt: SendAttempt) {
      setFailedSends((current) => current.filter((item) => item !== attempt));
    },
  };
}
