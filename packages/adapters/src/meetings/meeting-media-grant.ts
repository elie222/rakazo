import { createHmac } from "node:crypto";
import type { MeetingJoinRequest } from "@rakazo/adapter-kit";
import { resolveMeetingSigningKey } from "@rakazo/core/node/secrets-guard";

export const MEETING_MEDIA_PATH = "/api/meetings/media";

export function meetingMediaSignature(signingSecret: string, value: string) {
  return createHmac("sha256", signingSecret)
    .update(`meeting-media/v2\0${value}`)
    .digest("base64url");
}

export function meetingMediaPageUrl(
  { publicOrigin, signingSecret }: { publicOrigin: string; signingSecret: string },
  sessionId: string,
  expiresAt: Date,
  voice: boolean,
) {
  const url = new URL(MEETING_MEDIA_PATH, publicOrigin);
  const grant = `${sessionId}.${expiresAt.getTime()}.${voice ? "voice" : "camera"}`;
  url.hash = `${grant}.${meetingMediaSignature(signingSecret, grant)}`;
  return url.href;
}

export function configuredMeetingMedia(source = process.env) {
  const configured = source.MEETING_PUBLIC_ORIGIN?.trim();
  if (!configured) return undefined;
  const origin = URL.parse(configured);
  if (origin?.protocol !== "https:" || origin.href !== `${origin.origin}/`) {
    throw new Error("MEETING_PUBLIC_ORIGIN must be a public HTTPS origin");
  }
  const options = { publicOrigin: origin.origin, signingSecret: resolveMeetingSigningKey(source) };
  const voice = source.MEETING_LIVE_VOICE === "true";
  return {
    ...options,
    voice,
    buildJoin(input: MeetingJoinRequest) {
      return {
        ...input,
        liveVoice: voice,
        mediaUrl: meetingMediaPageUrl(options, input.sessionId, input.expiresAt, voice),
      };
    },
  };
}
