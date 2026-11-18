import { once } from "node:events";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { MEETING_SAMPLE_RATE, meetingAudioWav } from "./meeting-audio.js";
import type { MeetingMediaSession } from "./meeting-media-bridge.js";
import { createMeetingMediaBridge } from "./meeting-media-bridge.js";

export const DEMO_MEDIA_SESSION = "meeting-emulator";

export function meetingTone(samples: number) {
  const pcm = Buffer.alloc(samples * 2);
  for (let offset = 0; offset < samples; offset++) {
    pcm.writeInt16LE(
      Math.round(5_000 * Math.sin((2 * Math.PI * 440 * offset) / MEETING_SAMPLE_RATE)),
      offset * 2,
    );
  }
  return pcm;
}

export function createMeetingMediaEmulator(publicOrigin: string) {
  const session: MeetingMediaSession = {
    actor: {
      userId: "emulator-user",
      email: "meeting@example.test",
      spaceId: "emulator-space",
      isDeploymentOwner: false,
    },
    botId: "emulator-bot",
    botName: "Atlas",
    voice: true,
    admitted: true,
  };
  const received: Uint8Array[] = [];
  let revoked = false;
  let silent = false;
  let voiceAvailable: boolean | "retry" = true;
  let readinessChecks = 0;
  let beforeReply: (() => Promise<void>) | undefined;

  const bridge = createMeetingMediaBridge({
    signingSecret: "meeting-emulator-secret",
    publicOrigin,
    loadSession: async (sessionId) =>
      !revoked && sessionId === DEMO_MEDIA_SESSION ? session : null,
    voiceReady: async () => {
      readinessChecks++;
      return voiceAvailable;
    },
    respond: async (_session, audio, signal) => {
      received.push(audio);
      await beforeReply?.();
      signal.throwIfAborted();
      if (silent) return { clip: null };
      return {
        context: "Participant: When is the demo?",
        spokenContext: "Participant: When is the demo?\nBot: Thursday.",
        clip: {
          bytes: meetingAudioWav(meetingTone(MEETING_SAMPLE_RATE * 2)),
          mimeType: "audio/wav",
        },
      };
    },
  });

  return {
    bridge,
    received,
    session,
    get readinessChecks() {
      return readinessChecks;
    },
    revoke: () => {
      revoked = true;
    },
    setSilent: (value: boolean) => {
      silent = value;
    },
    setVoiceAvailable: (value: boolean | "retry") => {
      voiceAvailable = value;
    },
    beforeReply: (work: () => Promise<void>) => {
      beforeReply = work;
    },
    url: () => bridge.pageUrl(DEMO_MEDIA_SESSION, new Date(Date.now() + 60_000), true),
  };
}

export async function browserMeetingMediaEmulator() {
  const app = new Hono();
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Meeting fixture has no loopback address");
  }
  const emulator = createMeetingMediaEmulator(`http://127.0.0.1:${address.port}`);
  emulator.bridge.mount(app);
  return { ...emulator, close: () => server.close() };
}
