import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { LeaseHeldError, recordUsage, runAsTenant, withLease } from "@rakazo/db";
import * as z from "zod";
import type { VoiceDeps } from "../../calls/voice.js";
import {
  loadDefaultVoiceCredential,
  synthesizeVoice,
  transcribeVoice,
  voiceProviderFor,
} from "../../calls/voice.js";
import type { MeetingMediaSession } from "./meeting-media-bridge.js";
import { createMeetingMediaBridge } from "./meeting-media-bridge.js";
import { meetingReplyInstructions } from "./meeting-reply.prompt.js";

const replySchema = z.object({ reply: z.string().trim().min(1).max(420).nullable() });

export function createMeetingMedia(
  deps: VoiceDeps & {
    /** This runtime must be constructed without persistent session recording. */
    runtime: AgentRuntime;
    resolveModel: (scope: {
      userId: string;
      spaceId: string;
      botId: string;
    }) => Promise<AgentRunRequest["model"]>;
    signingSecret: string;
    publicOrigin: string;
    loadSession: (sessionId: string) => Promise<MeetingMediaSession | null>;
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
              const answer = await reply(session, utterance, lease.signal);
              if (!answer) return { clip: null, context };
              const clip = await synthesizeVoice(deps, session.actor, {
                botId: session.botId,
                text: answer,
                callId: session.sessionId,
                signal: lease.signal,
              });
              return {
                clip,
                context: `${context}
Bot: ${answer}`,
              };
            },
          );
        } catch (error) {
          // Keep a single in-flight speech turn per meeting across API replicas.
          if (error instanceof LeaseHeldError) return { clip: null };
          throw error;
        }
      }),
  });

  return bridge;

  async function reply(
    session: MeetingMediaSession & { recentSpeech: string },
    utterance: string,
    signal: AbortSignal,
  ) {
    const id = `meeting-voice:${randomUUID()}`;
    const scope = {
      spaceId: session.actor.spaceId,
      userId: session.actor.userId,
      botId: session.botId,
    };
    const onUsage = async (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => {
      await recordUsage(deps.prisma, event, { ...scope, operationId: id, operationKind: "setup" });
    };
    const model = await deps.resolveModel(scope);
    signal.throwIfAborted();
    for await (const event of deps.runtime.run(
      {
        botId: scope.botId,
        runId: id,
        threadId: id,
        instructions: meetingReplyInstructions(),
        prompt: JSON.stringify({
          participantName: session.botName,
          earlierMeeting: session.recentTranscript?.slice(-6_000) || session.recentSpeech,
          latestUtterance: utterance,
        }),
        history: [],
        tools: [],
        model: {
          ...model,
          thinkingLevel: "off",
          maxTokens: Math.min(model.maxTokens ?? 640, 640),
        },
        usageOperationKind: "setup",
        onUsage,
        allowSilentEmpty: true,
      },
      { ...scope, operationId: id, traceId: id, signal },
    )) {
      if (event.type === "usage" && !event.accounted) await onUsage(event);
      if (event.type === "done") {
        try {
          return replySchema.safeParse(JSON.parse(event.text ?? "")).data?.reply ?? null;
        } catch (error) {
          if (error instanceof SyntaxError) return null;
          throw error;
        }
      }
    }
    return null;
  }
}

export function meetingVoiceReady(deps: VoiceDeps, actor: Actor, signal?: AbortSignal) {
  return runAsTenant(actor, async () => {
    const [speaker, listener] = await Promise.all([
      loadDefaultVoiceCredential(deps, actor, undefined, signal),
      loadDefaultVoiceCredential(deps, actor, undefined, signal, "transcribe"),
    ]);
    if (!speaker || !listener) return false;
    return Boolean((await voiceProviderFor(deps, listener.cred.provider)).transcribe);
  });
}
