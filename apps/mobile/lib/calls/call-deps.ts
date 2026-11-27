import { t } from "@lingui/core/macro";
import {
  ACTIVE_RUN_STATUSES,
  abortableDelay,
  isRetryableError,
  latestSpokenCallReply,
  recognitionLocaleTag,
  reduceThreadSnapshot,
  retryDelayMs,
  speechFromBlocks,
} from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import type { ApiRequestContext } from "../api/api";
import { captureApiRequestContext, rpc } from "../api/api";
import { subscribeThread } from "../api/api-live";
import type { MobileMessage, MobileSnapshot } from "../api/mobile-types";
import { currentSessionGeneration } from "../api/session";
import { deviceLanguage, getActiveUiLocale } from "../i18n/i18n";
import * as dictation from "../voice/dictation";
import type { SpeechOwner } from "../voice/voice";
import {
  createSpeechOwner,
  ensureVoiceConsent,
  queueSpeech,
  setCallAudio,
  speakText,
  stopSpeaking,
} from "../voice/voice";
import { recordClip, transcribeClip } from "../voice/voice-clip";
import type { CallDeps, CallEnded, DictationHandlers } from "./call-session";
import {
  playCallCue,
  preloadWaitSound,
  releaseWaitSound,
  startWaitSound,
  stopWaitSound,
} from "./call-sounds";

/** A call that cannot reach the microphone or the server this many turns in a row hangs up. */
export const MAX_TURN_FAILURES = 3;

/** A dropped live feed is reconnected from the last seq it saw, backing off as it retries. */
const FEED_RETRY_MIN_MS = 250;
const FEED_RETRY_MAX_MS = 5_000;

/** The call a set of production deps serves, and how they hand a lost call back to the session. */
export type CallDepsContext = {
  callId: string;
  autoLanguage: boolean;
  /** The session the call started in: a late request fails instead of going out with a newer one. */
  generation: number;
  requestContext?: ApiRequestContext;
  /** The server rejected the call's session; `own` tells whether these deps still serve the call. */
  onUnauthorized: (own: CallDeps) => void;
  /** The live feed cannot go on: the call hangs up from the caller's side. */
  onFeedLost: () => void;
};

export function productionDeps({
  callId: sessionCallId,
  autoLanguage,
  generation,
  requestContext,
  onUnauthorized,
  onFeedLost,
}: CallDepsContext): CallDeps {
  // One owner per call: its hang-up stops only its own speech, never
  // unrelated read-aloud that has since replaced it.
  const speechOwner = createSpeechOwner();
  const callContext = async () => {
    const context = requestContext ?? (await captureApiRequestContext());
    if (context.sessionGeneration !== generation || currentSessionGeneration() !== generation)
      throw new Error(t`Something went wrong. Try again.`);
    return context;
  };
  // The server rejected this call's session: stop listening instead of opening the
  // microphone for another turn. The next ordinary request handles the sign-out.
  const endOnUnauthorized = async <T>(request: Promise<T>): Promise<T> => {
    try {
      return await request;
    } catch (error) {
      if ((error as { status?: unknown }).status === 401) onUnauthorized(own);
      throw error;
    }
  };
  const own: CallDeps = {
    dictate: dictateTurn,
    record: async (signal) => {
      await ensureVoiceConsent(await callContext());
      return recordClip(signal);
    },
    transcribe: async (clip, signal) =>
      transcribeClip(clip, signal, await callContext(), { callId: sessionCallId, autoLanguage }),
    send: (botId, text, clientNonce) =>
      endOnUnauthorized(
        callContext().then(async (requestContext) => {
          const sent = await rpc("threads/send", { botId, clientNonce, text }, { requestContext });
          return sent.runId;
        }),
      ),
    answer: (botId, ask, clientNonce) =>
      endOnUnauthorized(
        callContext().then(async (requestContext) => {
          await rpc("threads/answer", { botId, ...ask, clientNonce }, { requestContext });
        }),
      ),
    followUp: (botId, text, clientNonce) =>
      endOnUnauthorized(
        callContext().then(async (requestContext) => {
          await rpc("threads/followUp", { botId, text, clientNonce }, { requestContext });
        }),
      ),
    endCall: async (botId, id) => closeCall(botId, id, await callContext()),
    speak: (botId, text, queue) =>
      speakReply(botId, text, speechOwner, sessionCallId, requestContext, queue),
    stopSpeaking: () => stopSpeaking(speechOwner),
    audio: setCallAudio,
    cue: playCallCue,
    waitSound: (action) => {
      if (action === "start") void bestEffort("start call wait sound", startWaitSound());
      else if (action === "stop") stopWaitSound();
      else if (action === "preload") void bestEffort("preload call wait sound", preloadWaitSound());
      else releaseWaitSound();
    },
    watch: (botId, onReply, onEnded, onThread) =>
      watchReplies(
        botId,
        sessionCallId,
        { onReply, onEnded, onThread, onFeedLost },
        requestContext,
      ),
  };
  return own;
}

/** The device's own speech recognition, which works with a speak-only voice provider. */
async function dictateTurn(handlers: DictationHandlers, signal: AbortSignal): Promise<boolean> {
  if (!(await dictation.available())) return false;
  const lang = recognitionLocaleTag(getActiveUiLocale(), await deviceLanguage());
  await dictation.listen({ ...handlers, signal, lang, call: true });
  return true;
}

async function closeCall(
  botId: string,
  id: string,
  requestContext: ApiRequestContext,
): Promise<void> {
  await rpc("threads/endCall", { botId, callId: id }, { requestContext });
}

async function speakReply(
  botId: string,
  text: string,
  owner: SpeechOwner,
  callId: string,
  requestContext?: ApiRequestContext,
  queue = false,
): Promise<void> {
  const say = queue ? queueSpeech : speakText;
  if (!(await say(text, { botId, owner, callId, requestContext }))) {
    throw new Error(t`Add a voice provider in Voice settings.`);
  }
}

/** Live feed for the bot on the call, independent of whichever thread is on screen. */
function watchReplies(
  botId: string,
  watchedCallId: string,
  feed: {
    onReply: (messageId: string, text: string, runId?: string) => void;
    onEnded: (ended: CallEnded) => void;
    onThread: (thread: MobileSnapshot, nextReply?: MobileMessage) => void;
    onFeedLost: () => void;
  },
  requestContext?: ApiRequestContext,
): () => void {
  const { onReply: onNewReply, onEnded, onThread, onFeedLost } = feed;
  const controller = new AbortController();
  const follow = async () => {
    let snapshot: MobileSnapshot | null = null;
    let lastSeen: string | null = null;
    let cursor = 0;
    let retry = FEED_RETRY_MIN_MS;
    let failure: unknown;
    let firstLoadFailures = 0;
    // The stream returns on an idle timeout as well as on a real failure, and a call
    // outlives both: pick it back up from the last seq until the caller hangs up. The
    // first snapshot is loaded in here too, so a failed load retries instead of
    // leaving the call with an open microphone and no feed.
    while (!controller.signal.aborted) {
      try {
        if (!snapshot) {
          snapshot = await rpc(
            "threads/get",
            { botId },
            { signal: controller.signal, requestContext },
          );
          lastSeen = latestSpokenCallReply(snapshot.messages, watchedCallId)?.id ?? null;
          cursor = snapshot.cursor ?? 0;
          onThread(snapshot);
        }
        await subscribeThread(
          { botId },
          cursor,
          (event) => {
            if (typeof event.seq === "number") cursor = event.seq;
            if (event.type === "thread.call.ended") {
              onEnded({
                callId: asText(event.payload?.callId),
                farewell: asText(event.payload?.farewell),
              });
              return;
            }
            const previous = snapshot;
            snapshot = reduceThreadSnapshot(snapshot, event) ?? snapshot;
            if (!snapshot) return;
            const message = latestSpokenCallReply(snapshot.messages, watchedCallId);
            // Wait for this reply's run, which can be behind another active run.
            const run = snapshot.activeRuns?.find((active) => active.id === message?.runId);
            const ownRun =
              run ?? (!message?.runId || snapshot.run?.id === message.runId ? snapshot.run : null);
            const reply =
              message &&
              message.id !== lastSeen &&
              !ACTIVE_RUN_STATUSES.some((status) => status === ownRun?.status)
                ? message
                : undefined;
            if (snapshot !== previous) onThread(snapshot, reply);
            if (!reply) return;
            lastSeen = reply.id;
            onNewReply(reply.id, speechFromBlocks(reply.blocks).trim(), reply.runId);
          },
          controller.signal,
          requestContext,
        );
        retry = FEED_RETRY_MIN_MS;
        failure = undefined;
      } catch (error) {
        if (controller.signal.aborted) return;
        // A 4xx other than 408/429 is the server's answer; asking again only polls it. The
        // call cannot go on without the feed, whether or not a snapshot is already on screen:
        // hang it up, from the caller's side so the server is told. A first load that keeps
        // failing ends it too, after as many tries as a run of failed turns.
        const giveUp =
          !isRetryableError(error) || (!snapshot && ++firstLoadFailures >= MAX_TURN_FAILURES);
        if (giveUp) {
          onFeedLost();
          return;
        }
        retry = Math.min(FEED_RETRY_MAX_MS, retry * 2);
        failure = error;
      }
      if (controller.signal.aborted) return;
      await abortableDelay(retryDelayMs(failure, retry), controller.signal);
    }
  };
  void bestEffort("follow the call's live reply feed", follow());
  return () => controller.abort();
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
