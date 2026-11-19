import type { MeetingJoinRequest, MeetingProvider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { MeetingEmulator } from "../providers/meeting/emulator/meeting-emulator.js";
import { RecallMeetingProvider } from "../providers/meeting/recall/recall-meeting.js";
import {
  BOT_ID,
  RECORDING_ID,
  RecallMeetingEmulator,
  signedMeetingEvent,
  TRANSCRIPT_ID,
  webhookSecret,
} from "../providers/meeting/recall/recall-meeting-emulator.test-support.js";
import { parseMeetingUrl } from "./meeting-link.js";
import { configuredMeetingMedia } from "./meeting-media-grant.js";
import { configuredMeetingSpaces } from "./meeting-provider.js";

const input: MeetingJoinRequest = {
  sessionId: "meeting-session-123",
  platform: "google_meet",
  meetingUrl: "https://meet.google.com/abc-defg-hij",
  botName: "Atlas · Rakazo",
  expiresAt: new Date("2026-11-19T19:30:00.000Z"),
};
const signal = new AbortController().signal;

function real(emulator = new RecallMeetingEmulator(), prefix: "webhook" | "svix" = "webhook") {
  return new RecallMeetingProvider({
    origin: "https://us-east-1.recall.ai",
    apiKey: "fake-key",
    verification: { secret: webhookSecret, prefix },
    fetch: emulator.fetch,
  });
}

it("enables all Spaces only when the operator explicitly asks for them", () => {
  const provider = real();
  expect(configuredMeetingSpaces(provider, { MEETING_SPACE_IDS: " * " })).toBeUndefined();
  expect(configuredMeetingSpaces(provider, {})).toEqual(new Set());
  expect(configuredMeetingSpaces(provider, { MEETING_SPACE_IDS: "space-a, space-b" })).toEqual(
    new Set(["space-a", "space-b"]),
  );
});

describe.each<{ name: string; create(): MeetingProvider }>([
  { name: "meeting emulator", create: () => new MeetingEmulator() },
  { name: "Recall HTTP adapter", create: () => real() },
])("$name conformance", ({ create }) => {
  it("dispatches, correlates, and removes a meet session", async () => {
    const provider = create();
    expect(provider.describe().capabilities.platforms).toContain(input.platform);
    const joined = await provider.join(input, signal);
    expect(joined.sessionId).toBe(input.sessionId);
    expect(await provider.find(input.sessionId, signal)).toMatchObject({
      externalId: joined.externalId,
    });
    await provider.leave(joined.externalId, signal);
  });
});

describe("Recall transcripts and delivery over the wire emulator", () => {
  it("imports and removes a recording without requesting a duplicate transcript", async () => {
    const emulator = new RecallMeetingEmulator();
    const provider = real(emulator);
    await provider.join(input, signal);
    expect(emulator.requests[0]?.body).toMatchObject({
      meeting_url: input.meetingUrl,
      metadata: { meetingSessionId: input.sessionId },
      recording_config: {
        retention: { type: "timed", hours: 24 },
        video_mixed_layout: "audio_only",
      },
    });
    expect(await provider.requestTranscript(RECORDING_ID, signal)).toEqual({
      id: TRANSCRIPT_ID,
      ready: false,
    });
    expect(await provider.requestTranscript(RECORDING_ID, signal)).toEqual({
      id: TRANSCRIPT_ID,
      ready: true,
    });
    expect(await provider.downloadTranscript(TRANSCRIPT_ID, signal)).toEqual([
      { speaker: "Sam Chen", startMs: 1100, text: "Yes." },
      { speaker: "Alex Rivera", startMs: 2600, text: "Friday." },
    ]);
    await provider.deleteRecording(RECORDING_ID, signal);
    expect(
      emulator.requests.filter(
        ({ method, path }) => method === "POST" && path.includes("create_transcript"),
      ),
    ).toHaveLength(1);
  });

  it.each(["webhook", "svix"] as const)(
    "verifies %s signatures and translates transcript events",
    (prefix) => {
      const provider = real(new RecallMeetingEmulator(), prefix);
      const delivery = signedMeetingEvent(
        {
          event: "transcript.done",
          data: {
            data: { updated_at: "2026-11-19T19:30:00.000Z" },
            bot: { id: BOT_ID, metadata: { meetingSessionId: input.sessionId } },
            recording: { id: RECORDING_ID },
            transcript: { id: TRANSCRIPT_ID },
          },
        },
        prefix,
      );
      expect(provider.verifyWebhook(delivery.raw, delivery.headers)).toMatchObject({
        sessionId: input.sessionId,
        externalId: BOT_ID,
        recordingId: RECORDING_ID,
        transcriptId: TRANSCRIPT_ID,
        status: "processing",
      });
      expect(provider.verifyWebhook(`${delivery.raw} `, delivery.headers)).toBe("invalid");
    },
  );

  it("exposes an unambiguous capacity rejection and retry delay", async () => {
    const emulator = new RecallMeetingEmulator();
    emulator.joinStatus = 507;
    await expect(real(emulator).join(input, signal)).rejects.toMatchObject({
      retryAfterMs: 30_000,
    });
  });
});

it("validates common links and preserves Zoom's opaque passcode", () => {
  expect(parseMeetingUrl("https://org.zoom.us/j/123456789?pwd=abc%2Bxyz&foo=1")).toEqual({
    platform: "zoom",
    url: "https://org.zoom.us/j/123456789?pwd=abc%2Bxyz",
    key: "123456789",
  });
  expect(parseMeetingUrl("https://meet.google.com/abc-defg-hij?entry=calendar")).toEqual({
    platform: "google_meet",
    url: input.meetingUrl,
    key: "/abc-defg-hij",
  });
  expect(() => parseMeetingUrl("https://meet.google.com.evil.example/abc-defg-hij")).toThrow(
    "Enter a valid Zoom, Google Meet, or Microsoft Teams link.",
  );
  expect(() => parseMeetingUrl("http://127.0.0.1:8080/j/123456789")).toThrow(
    "Enter a valid Zoom, Google Meet, or Microsoft Teams link.",
  );
});

it("sends a Teams meeting link and its passcode to the provider", async () => {
  const meeting = parseMeetingUrl(
    "https://teams.cloud.microsoft/meet/123456789012?p=fake%2Bpasscode&ref=invite",
  );
  const emulator = new RecallMeetingEmulator();
  const provider = real(emulator);
  expect(provider.describe().capabilities.platforms).toContain(meeting.platform);
  await provider.join(
    {
      ...input,
      platform: meeting.platform,
      meetingUrl: meeting.url,
      mediaUrl: "https://example.test/camera",
    },
    signal,
  );
  expect(emulator.requests[0]?.body).toMatchObject({
    meeting_url: "https://teams.cloud.microsoft/meet/123456789012?p=fake%2Bpasscode",
    variant: { microsoft_teams: "web_4_core" },
  });
});

it("preserves Teams meeting context and rejects look-alike or non-meeting links", () => {
  const path = "/l/meetup-join/19%3Ameeting_Fake%2Bthread%40thread.v2/0";
  const context = "%7B%22Tid%22%3A%22fake-tenant%22%7D";
  const invite = `https://teams.microsoft.com${path}?context=${context}`;
  expect(parseMeetingUrl(`${invite}&ref=invite#ignored`)).toEqual({
    platform: "microsoft_teams",
    url: invite,
    key: "19:meeting_Fake+thread@thread.v2",
  });
  const rawPlusInvite = `https://teams.microsoft.com/l/meetup-join/19%3Ameeting_Fake+thread%40thread.v2/0?context=${context}`;
  expect(parseMeetingUrl(rawPlusInvite)).toMatchObject({
    url: rawPlusInvite,
    key: "19:meeting_Fake+thread@thread.v2",
  });
  expect(() => parseMeetingUrl(`https://teams.microsoft.com.example.test${path}`)).toThrow(
    "Enter a valid Zoom, Google Meet, or Microsoft Teams link.",
  );
  expect(() => parseMeetingUrl("https://teams.microsoft.com/download")).toThrow(
    "Enter a valid Zoom, Google Meet, or Microsoft Teams link.",
  );
});

it.each([
  {
    voice: false,
    notice: "Rakazo is capturing audio to create a meeting transcript.",
  },
  {
    voice: true,
    notice:
      "Rakazo is capturing audio to create a meeting transcript. It also processes speech in real time with AI services and may reply aloud when addressed by name.",
  },
])("discloses whether the branded camera has live voice ($voice)", async ({ voice, notice }) => {
  const emulator = new RecallMeetingEmulator();
  const media = configuredMeetingMedia({
    MEETING_PUBLIC_ORIGIN: "https://api.example.test",
    MEETING_SIGNING_KEY: "2a".repeat(32),
    MEETING_LIVE_VOICE: String(voice),
  });
  const join = media?.buildJoin(input);
  expect(join?.liveVoice).toBe(voice);
  expect(new URL(join?.mediaUrl ?? "").hash.split(".")[2]).toBe(voice ? "voice" : "camera");

  await real(emulator).join(join!, signal);
  expect(emulator.requests[0]?.body).toMatchObject({
    variant: { google_meet: "web_4_core" },
    chat: { on_bot_join: { send_to: "everyone", message: notice } },
    output_media: { camera: { kind: "webpage", config: { url: join?.mediaUrl } } },
  });
  const body = emulator.requests[0]?.body;
  if (voice)
    expect(body).toMatchObject({ recording_config: { include_bot_in_recording: { audio: true } } });
  else expect(body).not.toHaveProperty("recording_config.include_bot_in_recording");
});
