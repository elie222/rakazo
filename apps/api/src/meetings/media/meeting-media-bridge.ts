import { timingSafeEqual } from "node:crypto";
import type { SpeechClip } from "@rakazo/adapter-kit";
import {
  MEETING_MEDIA_PATH,
  meetingMediaPageUrl,
  meetingMediaSignature,
} from "@rakazo/adapters/meeting-media";
import type { Actor } from "@rakazo/contracts";
import { deadlineSignal } from "@rakazo/core";
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
const NO_STORE = { "cache-control": "no-store" };

export interface MeetingMediaSession {
  actor: Actor;
  botId: string;
  botName: string;
  /** A branding-only camera never requests the microphone. */
  voice: boolean;
  admitted: boolean;
  recentTranscript?: string;
}

type ActiveSession = MeetingMediaSession & { sessionId: string; recentSpeech: string };

export function createMeetingMediaBridge(deps: {
  signingSecret: string;
  publicOrigin: string;
  loadSession: (sessionId: string) => Promise<MeetingMediaSession | null>;
  respond: (
    session: ActiveSession,
    audio: Uint8Array,
    signal: AbortSignal,
  ) => Promise<{ clip: SpeechClip | null; context?: string }>;
}) {
  const context = meetingTurnContext(deps.signingSecret);
  async function authenticate(request: Request) {
    const token = request.headers
      .get("authorization")
      ?.match(/^Bearer ([\w-]{1,160})\.(\d{1,14})\.([\w-]{43})$/);
    if (!token) return null;
    const [, sessionId, expiresAt, claimedSignature] = token;
    if (!sessionId || !expiresAt || !claimedSignature || Number(expiresAt) <= Date.now()) {
      return null;
    }
    const expected = meetingMediaSignature(deps.signingSecret, `${sessionId}.${expiresAt}`);
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(claimedSignature))) return null;
    const session = await deps.loadSession(sessionId);
    return session
      ? { ...session, sessionId, expiresAt: Number(expiresAt), grant: token[0] }
      : null;
  }

  return {
    pageUrl(sessionId: string, expiresAt: Date) {
      return meetingMediaPageUrl(deps, sessionId, expiresAt);
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
        return c.json({ botName: session.botName, voice: session.voice }, 200, NO_STORE);
      });
      app.post(`${MEETING_MEDIA_PATH}/turn`, async (c) => {
        const session = await authenticate(c.req.raw);
        if (!session?.voice) return c.body(null, 401, NO_STORE);
        // A launch can connect its media before the admission event reaches the API.
        if (!session.admitted) return c.body(null, 204, NO_STORE);
        const signal = deadlineSignal(
          Math.min(18_000, Math.max(1, session.expiresAt - Date.now())),
          c.req.raw.signal,
        );
        if (c.req.header("content-type") !== "application/octet-stream") {
          return c.body(null, 415, NO_STORE);
        }
        const bytes = await readBoundedBytes(c.req.raw, MAX_MEETING_AUDIO_BYTES);
        if (!bytes) return c.body(null, 413, NO_STORE);
        if (bytes.length < 2 || bytes.length % 2 !== 0) return c.body(null, 400, NO_STORE);

        signal.throwIfAborted();
        const recentSpeech = context.open(c.req.header(CONTEXT_HEADER), session.grant);
        const turn = await deps.respond(
          { ...session, recentSpeech },
          meetingAudioWav(bytes),
          signal,
        );
        signal.throwIfAborted();
        const current = await authenticate(c.req.raw);
        if (!current?.admitted || !current.voice) return c.body(null, 401, NO_STORE);
        const headers = turn.context
          ? { ...NO_STORE, [CONTEXT_HEADER]: context.seal(turn.context, session.grant) }
          : NO_STORE;
        if (!turn.clip) return c.body(null, 204, headers);

        return new Response(new Uint8Array(turn.clip.bytes), {
          headers: { ...headers, "content-type": turn.clip.mimeType },
        });
      });
    },
  };
}
