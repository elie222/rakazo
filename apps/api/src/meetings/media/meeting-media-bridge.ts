import type { SpeechClip } from "@rakazo/adapter-kit";
import {
  MEETING_MEDIA_PATH,
  meetingMediaPageUrl,
  meetingMediaSignature,
} from "@rakazo/adapters/meeting-media";
import type { Actor } from "@rakazo/contracts";
import { pollUntil, requestDeadline } from "@rakazo/core";
import { timingSafeStringEqual } from "@rakazo/core/node/secrets-guard";
import type { Hono } from "hono";
import { readBoundedBytes } from "../../http/http-body.js";
import { MAX_MEETING_AUDIO_BYTES, meetingAudioWav } from "./meeting-audio.js";
import { meetingBrand } from "./meeting-brand.js";
import {
  meetingAudioWorklet,
  meetingBridgeScript,
  meetingPage,
  meetingTileStyles,
} from "./meeting-page.js";
import { meetingTurnContext } from "./meeting-turn-context.js";

const CONTEXT_HEADER = "x-meeting-context";
const SPOKEN_CONTEXT_HEADER = "x-meeting-spoken-context";
const NO_STORE = { "cache-control": "no-store" };

export interface MeetingMediaSession {
  actor: Actor;
  botId: string;
  botName: string;
  /** Whether this deployment has enabled voice for the camera page. */
  voice: boolean;
  admitted: boolean;
}

type ActiveSession = MeetingMediaSession & { sessionId: string; recentSpeech: string };

export function createMeetingMediaBridge(deps: {
  signingSecret: string;
  publicOrigin: string;
  /** Revalidate session access without resolving speech connections. */
  loadSession: (sessionId: string) => Promise<MeetingMediaSession | null>;
  voiceReady: (session: MeetingMediaSession, signal: AbortSignal) => Promise<boolean | "retry">;
  respond: (
    session: ActiveSession,
    audio: Uint8Array,
    signal: AbortSignal,
  ) => Promise<{ clip: SpeechClip | null; context?: string; spokenContext?: string }>;
}) {
  const context = meetingTurnContext(deps.signingSecret);
  async function authenticate(request: Request) {
    const token = request.headers
      .get("authorization")
      ?.match(/^Bearer ([\w-]{1,160})\.(\d{1,14})\.(voice|camera)\.([\w-]{43})$/);
    if (!token) return null;
    const [, sessionId, expiresAt, mode, claimedSignature] = token;
    if (!sessionId || !expiresAt || !mode || Number(expiresAt) <= Date.now()) {
      return null;
    }
    const expected = meetingMediaSignature(deps.signingSecret, `${sessionId}.${expiresAt}.${mode}`);
    if (!timingSafeStringEqual(claimedSignature, expected)) return null;
    const session = await deps.loadSession(sessionId);
    return session
      ? {
          ...session,
          // The grant must match the join that disclosed live voice, regardless of config changes.
          voice: session.voice && mode === "voice",
          sessionId,
          expiresAt: Number(expiresAt),
          grant: token[0],
        }
      : null;
  }

  return {
    pageUrl(sessionId: string, expiresAt: Date, voice: boolean) {
      return meetingMediaPageUrl(deps, sessionId, expiresAt, voice);
    },

    mount(app: Hono) {
      app.get(MEETING_MEDIA_PATH, (c) =>
        c.html(meetingPage, 200, {
          ...NO_STORE,
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          "permissions-policy": "microphone=(self), camera=()",
          "referrer-policy": "no-referrer",
        }),
      );
      app.get(`${MEETING_MEDIA_PATH}/tile.css`, (c) =>
        c.body(meetingTileStyles, 200, { "content-type": "text/css; charset=utf-8" }),
      );
      app.get(
        `${MEETING_MEDIA_PATH}/mark.webp`,
        () =>
          new Response(new Uint8Array(meetingBrand), {
            headers: { "content-type": "image/webp" },
          }),
      );
      app.get(`${MEETING_MEDIA_PATH}/bridge.js`, (c) =>
        c.body(meetingBridgeScript, 200, { "content-type": "text/javascript; charset=utf-8" }),
      );
      app.get(`${MEETING_MEDIA_PATH}/audio-worklet.js`, (c) =>
        c.body(meetingAudioWorklet, 200, { "content-type": "text/javascript; charset=utf-8" }),
      );
      app.get(`${MEETING_MEDIA_PATH}/session`, async (c) => {
        const session = await authenticate(c.req.raw);
        if (!session) return c.body(null, 401, NO_STORE);
        const request = c.req.raw;
        const voice =
          session.voice &&
          (
            await pollUntil(
              async () => {
                const readiness = await deps.voiceReady(session, request.signal);
                return readiness === "retry" ? null : { ready: readiness };
              },
              {
                intervalMs: 500,
                timeoutMs: 3_000,
                signal: request.signal,
                onTimeout: () => ({ ready: false }),
              },
            )
          ).ready;
        if (voice && !(await authenticate(request))?.voice) return c.body(null, 401, NO_STORE);
        return c.json({ botName: session.botName, voice }, 200, NO_STORE);
      });
      app.post(`${MEETING_MEDIA_PATH}/turn`, async (c) => {
        const session = await authenticate(c.req.raw);
        if (!session?.voice) return c.body(null, 401, NO_STORE);
        // A launch can connect its media before the admission event reaches the API.
        if (!session.admitted) return c.body(null, 204, NO_STORE);
        if (c.req.header("content-type") !== "application/octet-stream") {
          return c.body(null, 415, NO_STORE);
        }
        const deadline = requestDeadline(
          Math.min(18_000, Math.max(1, session.expiresAt - Date.now())),
          "Meeting voice turn deadline exceeded",
          c.req.raw.signal,
        );
        const { signal } = deadline;
        try {
          const bytes = await readBoundedBytes(c.req.raw, MAX_MEETING_AUDIO_BYTES, signal);
          if (!bytes) return c.body(null, 413, NO_STORE);
          if (bytes.length < 2 || bytes.length % 2 !== 0) return c.body(null, 400, NO_STORE);
          signal.throwIfAborted();
          const current = await authenticate(c.req.raw);
          if (!current?.admitted || !current.voice) return c.body(null, 401, NO_STORE);
          const readiness = await deps.voiceReady(current, signal);
          if (readiness === "retry") return c.body(null, 204, NO_STORE);
          if (!readiness) return c.body(null, 403, NO_STORE);
          const verified = await authenticate(c.req.raw);
          signal.throwIfAborted();
          if (
            !verified?.admitted ||
            !verified.voice ||
            verified.actor.userId !== current.actor.userId
          ) {
            return c.body(null, 401, NO_STORE);
          }
          const recentSpeech = context.open(c.req.header(CONTEXT_HEADER), verified.grant);
          const turn = await deps.respond(
            { ...verified, recentSpeech },
            meetingAudioWav(bytes),
            signal,
          );
          signal.throwIfAborted();
          const afterTurn = await authenticate(c.req.raw);
          signal.throwIfAborted();
          if (
            !afterTurn?.admitted ||
            !afterTurn.voice ||
            afterTurn.actor.userId !== verified.actor.userId
          ) {
            return c.body(null, 401, NO_STORE);
          }
          const headers = turn.context
            ? { ...NO_STORE, [CONTEXT_HEADER]: context.seal(turn.context, session.grant) }
            : NO_STORE;
          if (!turn.clip) return c.body(null, 204, headers);

          return new Response(new Uint8Array(turn.clip.bytes), {
            headers: {
              ...headers,
              "content-type": turn.clip.mimeType,
              ...(turn.spokenContext && {
                [SPOKEN_CONTEXT_HEADER]: context.seal(turn.spokenContext, session.grant),
              }),
            },
          });
        } catch (error) {
          if (
            signal.aborted &&
            (error === signal.reason ||
              (error instanceof Error &&
                (error.name === "AbortError" || error.name === "TimeoutError")))
          ) {
            return c.body(null, 204, NO_STORE);
          }
          throw error;
        } finally {
          deadline.dispose();
        }
      });
    },
  };
}
