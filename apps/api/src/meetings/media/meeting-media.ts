import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { ModelAccountError, VoiceAccountError } from "@rakazo/adapter-kit";
import {
  isRetiredModelCredentialError,
  NoVoiceConfigured,
  UnavailableModelForAuthError,
} from "@rakazo/adapters";
import { parseModelJson } from "@rakazo/adapters/model-json";
import type { Actor } from "@rakazo/contracts";
import { ClientError, MISSING_MODEL_RUN_ERROR, truncatePlainText } from "@rakazo/core";
import { LeaseHeldError, LeaseLostError, recordUsage, runAsTenant, withLease } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import * as z from "zod";
import type { VoiceDeps } from "../../calls/voice.js";
import {
  loadDefaultVoiceCredential,
  resolveVoiceTarget,
  synthesizeVoice,
  transcribeVoice,
  voiceProviderFor,
} from "../../calls/voice.js";
import { hasDeploymentVoiceConsent } from "../../voice/deployment-consent.js";
import type { MeetingMediaSession } from "./meeting-media-bridge.js";
import { createMeetingMediaBridge } from "./meeting-media-bridge.js";
import { meetingReplyPrompt } from "./meeting-reply.prompt.js";

type ModelScope = Pick<Actor, "userId" | "spaceId"> & { botId: string };
type ReplyModel = AgentRunRequest["model"];

const SPOKEN_REPLY_LIMIT = 420;
const replySchema = z.object({
  reply: z
    .string()
    .trim()
    .min(1)
    .transform((text) =>
      text.length <= SPOKEN_REPLY_LIMIT
        ? text
        : `${truncatePlainText(text, SPOKEN_REPLY_LIMIT - 1).trimEnd()}…`,
    )
    .nullable(),
});

export function createMeetingMedia(
  deps: VoiceDeps &
    Omit<Parameters<typeof createMeetingMediaBridge>[0], "respond"> & {
      /** This runtime must be constructed without persistent session recording. */
      runtime: AgentRuntime;
      resolveModel: (scope: ModelScope) => Promise<ReplyModel>;
    },
) {
  const bridge = createMeetingMediaBridge({
    ...deps,
    respond: (session, audio, signal) =>
      runAsTenant(session.actor, async () => {
        try {
          return await withLease(
            deps.prisma,
            `meeting-media:${session.sessionId}`,
            {
              ttlMs: 15_000,
              signal,
              onRenew: async () => {
                const current = await deps.loadSession(session.sessionId);
                return Boolean(current?.admitted && current.voice);
              },
            },
            async (lease) => {
              const scope = {
                userId: session.actor.userId,
                spaceId: session.actor.spaceId,
                botId: session.botId,
              };
              const model = await meetingReplyModel(scope);
              if (!model) return { clip: null };
              const { text } = await transcribeVoice(deps, session.actor, {
                audio,
                mimeType: "audio/wav",
                callId: session.sessionId,
                signal: lease.signal,
              });
              const utterance = text.trim().slice(0, 2_000);
              if (!utterance) return { clip: null };
              const context = `${session.recentSpeech}
Participant: ${utterance}`.trimStart();
              const answer = await reply(session, scope, model, utterance, lease.signal);
              if (!answer) return { clip: null, context };
              const clip = await synthesizeVoice(deps, session.actor, {
                botId: session.botId,
                text: answer,
                callId: session.sessionId,
                signal: lease.signal,
              });
              return {
                clip,
                context,
                spokenContext: `${context}
Bot: ${answer}`,
              };
            },
          );
        } catch (error) {
          if (error instanceof VoiceAccountError || error instanceof ModelAccountError) {
            getLogger().warn("Meeting voice connection refused", {
              "meeting.failure":
                error instanceof VoiceAccountError ? "voice_account" : "model_account",
            });
            return { clip: null };
          }
          // Leave or an overlapping turn can stop speech while the meeting is still live.
          if (
            error instanceof LeaseHeldError ||
            (error instanceof LeaseLostError && !error.cause) ||
            error instanceof NoVoiceConfigured ||
            (error instanceof ClientError && error.code === "AI_CONSENT_REQUIRED")
          ) {
            return { clip: null };
          }
          throw error;
        }
      }),
  });

  return bridge;

  async function meetingReplyModel(scope: ModelScope) {
    if (deps.runtime.describe().capabilities.scripted) return null;
    try {
      const model = await deps.resolveModel(scope);
      return model.provider === "scripted" ? null : model;
    } catch (error) {
      if (
        error instanceof UnavailableModelForAuthError ||
        isRetiredModelCredentialError(error) ||
        (error instanceof Error && error.message === MISSING_MODEL_RUN_ERROR)
      ) {
        return null;
      }
      throw error;
    }
  }

  async function reply(
    session: MeetingMediaSession & { recentSpeech: string },
    scope: ModelScope,
    model: ReplyModel,
    utterance: string,
    signal: AbortSignal,
  ) {
    const id = `meeting-voice:${randomUUID()}`;
    const onUsage = async (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => {
      await recordUsage(deps.prisma, event, { ...scope, operationId: id, operationKind: "answer" });
    };
    signal.throwIfAborted();
    for await (const event of deps.runtime.run(
      {
        botId: scope.botId,
        runId: id,
        threadId: id,
        ...meetingReplyPrompt({
          participantName: session.botName,
          earlierMeeting: session.recentSpeech,
          latestUtterance: utterance,
        }),
        history: [],
        tools: [],
        model: {
          ...model,
          thinkingLevel: "off",
          maxTokens: Math.min(model.maxTokens ?? 640, 640),
        },
        usageOperationKind: "answer",
        onUsage,
        allowSilentEmpty: true,
      },
      { ...scope, operationId: id, traceId: id, signal },
    )) {
      if (event.type === "usage" && !event.accounted) await onUsage(event);
      if (event.type === "done") {
        signal.throwIfAborted();
        return parseModelJson(event.text ?? "", replySchema)?.reply ?? null;
      }
    }
    return null;
  }
}

export function meetingVoiceReady(
  deps: VoiceDeps,
  actor: Actor,
  botId: string,
  signal?: AbortSignal,
) {
  return runAsTenant(actor, async () => {
    try {
      const [speaker, listener] = await Promise.all([
        resolveVoiceTarget(deps, actor, { botId, signal }),
        loadDefaultVoiceCredential(deps, actor, undefined, signal, "transcribe"),
      ]);
      if (!listener || !(await voiceProviderFor(deps, listener.cred.provider)).transcribe) {
        return false;
      }
      if (!(speaker.deployment || listener.deployment)) return true;
      const deployment = deps.env?.deploymentVoice;
      return Boolean(
        deployment &&
          (await hasDeploymentVoiceConsent(deps.prisma, actor, deployment, {
            synthesize: speaker.deployment,
            transcribe: listener.deployment,
          })),
      );
    } catch (error) {
      if (error instanceof NoVoiceConfigured) return false;
      if (error instanceof VoiceAccountError) return error.code ? false : ("retry" as const);
      throw error;
    }
  });
}
