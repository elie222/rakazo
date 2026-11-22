import { createHmac, timingSafeEqual } from "node:crypto";
import type { MeetingJoinRequest, MeetingObservation, MeetingProvider } from "@rakazo/adapter-kit";
import { MeetingJoinRejected } from "@rakazo/adapter-kit";
import type { MeetingTurn } from "@rakazo/contracts";
import { cancelResponseBody, parseRetryAfter, readBoundedJsonResponse } from "@rakazo/core";
import { z } from "zod";

const id = z.string().uuid();
const date = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const metadata = z.object({ meetingSessionId: z.string().max(128).optional() }).optional();
const botRef = z.object({ id, metadata });
const recording = z.object({ id, status: z.object({ code: z.string() }).optional() });
const artifact = z.object({
  id,
  status: z.object({ code: z.string() }).optional(),
  data: z.object({ download_url: z.url().nullish() }).nullish(),
});
const bot = botRef.extend({
  status_changes: z
    .array(z.object({ code: z.string(), sub_code: z.string().nullish(), created_at: date }))
    .optional(),
  recordings: z.array(recording).optional(),
});
const event = z.object({
  event: z.string(),
  data: z.object({
    bot: botRef.optional(),
    recording: z.object({ id }).optional(),
    transcript: z.object({ id }).optional(),
    data: z.object({ updated_at: date, sub_code: z.string().nullish() }).optional(),
  }),
});
const download = z.array(
  z.object({
    participant: z
      .object({
        id: z.number().optional(),
        name: z.string().nullish(),
        is_host: z.boolean().optional(),
      })
      .nullish(),
    words: z.array(
      z.object({
        text: z.string(),
        start_timestamp: z.object({ relative: z.number().nonnegative() }).nullish(),
      }),
    ),
  }),
);

// The provider reserves this speaker ID for bot output audio with perfect diarization.
// https://docs.recall.ai/docs/transcription-faq#who-is-participant-2147483647
const BOT_OUTPUT_SPEAKER_ID = 2_147_483_647;

const SECOND = 1000;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

export function buildRecallBotConfig(input: MeetingJoinRequest) {
  const liveVoice = Boolean(input.mediaUrl && input.liveVoice);
  const recordingNotice = "Rakazo is capturing audio to create a meeting transcript.";
  const liveNotice =
    " It also processes speech in real time with AI services and may reply aloud when addressed by name.";
  return {
    meeting_url: input.meetingUrl,
    bot_name: input.botName.slice(0, 100),
    metadata: { meetingSessionId: input.sessionId },
    chat: {
      on_bot_join: {
        send_to: "everyone",
        message: liveVoice ? recordingNotice + liveNotice : recordingNotice,
      },
    },
    ...(input.mediaUrl
      ? {
          variant: { [input.platform]: "web_4_core" },
          output_media: { camera: { kind: "webpage", config: { url: input.mediaUrl } } },
        }
      : {}),
    recording_config: {
      ...(liveVoice ? { include_bot_in_recording: { audio: true } } : {}),
      video_mixed_layout: "audio_only",
      retention: { type: "timed", hours: 24 },
    },
    automatic_leave: {
      waiting_room_timeout: 180,
      noone_joined_timeout: 180,
      everyone_left_timeout: { timeout: 15, activate_after: 30 },
      recording_permission_denied_timeout: 30,
      in_call_recording_timeout: 2 * 60 * 60,
    },
  };
}

export class RecallMeetingProvider implements MeetingProvider {
  constructor(
    private readonly config: {
      origin: string;
      apiKey: string;
      verification: { secret: string; prefix: "webhook" | "svix" };
      fetch?: typeof fetch;
    },
  ) {}

  describe() {
    return {
      id: "recall",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { platforms: ["zoom", "google_meet", "microsoft_teams"] as const },
    };
  }

  async join(input: MeetingJoinRequest, signal: AbortSignal) {
    const response = await this.call("bot/", signal, "POST", buildRecallBotConfig(input));
    if ([400, 401, 403, 404, 422, 429, 507].includes(response.status)) {
      cancelResponseBody(response);
      throw new MeetingJoinRejected(
        response.status === 429 || response.status === 507
          ? (parseRetryAfter(response.headers.get("retry-after")) ?? 30_000)
          : undefined,
      );
    }
    const result = await this.read(response, bot, signal);
    return this.observe(result, input.sessionId);
  }

  async find(sessionId: string, signal: AbortSignal) {
    const query = new URLSearchParams({ metadata__meetingSessionId: sessionId });
    const { results } = await this.read(
      await this.call(`bot/?${query}`, signal),
      z.object({ results: z.array(bot) }),
      signal,
    );
    const match = results.find((item) => item.metadata?.meetingSessionId === sessionId);
    return match ? this.observe(match, sessionId) : null;
  }

  async get(externalId: string, signal: AbortSignal) {
    const response = await this.call(`bot/${id.parse(externalId)}/`, signal);
    if (response.status === 404) {
      cancelResponseBody(response);
      return null;
    }
    return this.observe(await this.read(response, bot, signal));
  }

  async leave(externalId: string, signal: AbortSignal) {
    const response = await this.call(`bot/${id.parse(externalId)}/leave_call/`, signal, "POST");
    cancelResponseBody(response);
    if (response.ok) return undefined;
    if (response.status === 400 || response.status === 404) {
      const actual = await this.get(externalId, signal);
      if (!actual) return { externalId, occurredAt: new Date(), status: "ended" as const };
      if (
        actual.status === "ended" ||
        actual.status === "processing" ||
        actual.status === "failed"
      ) {
        return actual;
      }
    }
    throw new Error(`Meeting provider could not remove participant (HTTP ${response.status})`);
  }

  async requestTranscript(recordingId: string, signal: AbortSignal) {
    const recording = id.parse(recordingId);
    const query = new URLSearchParams({ recording_id: recording });
    const { results } = await this.read(
      await this.call(`transcript/?${query}`, signal),
      z.object({ results: z.array(artifact) }),
      signal,
    );
    const existing =
      results.find((item) => item.status?.code === "done") ??
      results.find((item) => item.status?.code === "processing");
    if (existing) return { id: existing.id, ready: existing.status?.code === "done" };
    const result = await this.read(
      await this.call(`recording/${recording}/create_transcript/`, signal, "POST", {
        provider: { recallai_async: { language_code: "auto" } },
        diarization: { use_separate_streams_when_available: true },
      }),
      artifact,
      signal,
    );
    return { id: result.id, ready: result.status?.code === "done" };
  }

  async transcriptReady(transcriptId: string, signal: AbortSignal) {
    const response = await this.call(`transcript/${id.parse(transcriptId)}/`, signal);
    if (response.status === 404) {
      cancelResponseBody(response);
      return false;
    }
    return (await this.read(response, artifact, signal)).status?.code === "done";
  }

  async downloadTranscript(
    transcriptId: string,
    signal: AbortSignal,
    options?: { selfName?: string },
  ): Promise<MeetingTurn[]> {
    const result = await this.read(
      await this.call(`transcript/${id.parse(transcriptId)}/`, signal),
      artifact,
      signal,
    );
    if (!result.data?.download_url) throw new Error("Meeting transcript is unavailable");
    const url = new URL(result.data.download_url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !(url.hostname.endsWith(".amazonaws.com") || url.hostname.endsWith(".recall.ai"))
    ) {
      throw new Error("Meeting transcript download origin is invalid");
    }
    const response = await (this.config.fetch ?? fetch)(url, { signal, redirect: "error" });
    const rows = await this.read(response, download, signal, MAX_DOWNLOAD_BYTES);
    return rows
      .flatMap(({ participant, words }) => {
        const text = words
          .map((word) => word.text.trim())
          .filter(Boolean)
          .join(" ");
        if (!text) return [];
        const speaker =
          participant?.id === BOT_OUTPUT_SPEAKER_ID
            ? options?.selfName || participant.name
            : participant?.name;
        return [
          {
            speaker: (speaker || "Unknown speaker").slice(0, 256),
            startMs: Math.round((words[0]?.start_timestamp?.relative ?? 0) * SECOND),
            text: text.slice(0, 32_000),
          },
        ];
      })
      .sort((a, b) => a.startMs - b.startMs);
  }

  async deleteRecording(recordingId: string, signal: AbortSignal) {
    const response = await this.call(`recording/${id.parse(recordingId)}/`, signal, "DELETE");
    cancelResponseBody(response);
    if (!response.ok && response.status !== 404) {
      throw new Error(`Meeting provider could not remove recording (HTTP ${response.status})`);
    }
  }

  verifyWebhook(body: string, headers: Headers) {
    if (!verifyRecallSignature(this.config.verification, body, headers)) return "invalid";
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch (error) {
      if (error instanceof SyntaxError) return "invalid";
      throw error;
    }
    const decoded = event.safeParse(json);
    if (!decoded.success) return "invalid";
    const { data, event: name } = decoded.data;
    if (!data.bot || !data.data) return "ignored";
    const observation = {
      externalId: data.bot.id,
      sessionId: data.bot.metadata?.meetingSessionId,
      occurredAt: data.data.updated_at,
    };
    if (name === "recording.done" && data.recording) {
      return {
        ...observation,
        status: "processing",
        recordingId: data.recording.id,
      } satisfies MeetingObservation;
    }
    if (name === "transcript.done" && data.recording && data.transcript) {
      return {
        ...observation,
        status: "processing",
        recordingId: data.recording.id,
        transcriptId: data.transcript.id,
      } satisfies MeetingObservation;
    }
    if (name === "recording.failed" || name === "transcript.failed") {
      return {
        ...observation,
        status: "failed",
        error: name === "recording.failed" ? "capture" : "transcript",
      } satisfies MeetingObservation;
    }
    if (!name.startsWith("bot.")) return "ignored";
    return { ...observation, ...statusFor(name.slice(4), data.data.sub_code) };
  }

  private observe(
    value: z.infer<typeof bot>,
    sessionId = value.metadata?.meetingSessionId,
  ): MeetingObservation {
    const status = value.status_changes?.at(-1);
    const recording = value.recordings?.find((recording) => recording.status?.code === "done");
    return {
      externalId: value.id,
      sessionId,
      occurredAt: status?.created_at ?? new Date(0),
      ...statusFor(status?.code ?? "ready", status?.sub_code),
      ...(recording && { recordingId: recording.id, status: "processing" as const }),
    };
  }

  private call(path: string, signal: AbortSignal, method = "GET", body?: unknown) {
    return (this.config.fetch ?? fetch)(new URL(`/api/v1/${path}`, this.config.origin), {
      method,
      headers: {
        Authorization: `Token ${this.config.apiKey}`,
        Accept: "application/json",
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      signal,
      redirect: "error",
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }

  private async read<T>(
    response: Response,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    maxBytes = 2 * 1024 * 1024,
  ) {
    if (!response.ok) {
      cancelResponseBody(response);
      throw new Error(`Meeting provider returned HTTP ${response.status}`);
    }
    const parsed = schema.safeParse(
      await readBoundedJsonResponse<unknown>(response, maxBytes, signal),
    );
    if (!parsed.success) throw new Error("Meeting provider returned an unexpected response");
    return parsed.data;
  }
}

function statusFor(
  code: string,
  subCode?: string | null,
): Pick<MeetingObservation, "status" | "error"> {
  switch (code) {
    case "ready":
    case "joining_call":
      return { status: "joining" };
    case "in_waiting_room":
      return { status: "waiting" };
    case "in_call_recording":
      return { status: "joined" };
    case "recording_permission_denied":
      return { status: "failed", error: "capture" };
    case "fatal":
      return { status: "failed", error: subCode?.includes("waiting_room") ? "admission" : "join" };
    case "call_ended":
      return subCode?.includes("waiting_room")
        ? { status: "failed", error: "admission" }
        : { status: "processing" };
    case "done":
      return { status: "ended" };
    default:
      return {};
  }
}

export function verifyRecallSignature(
  { secret, prefix }: { secret: string; prefix: "webhook" | "svix" },
  body: string,
  headers: Headers,
  now = Date.now(),
) {
  const id = headers.get(`${prefix}-id`);
  const timestamp = headers.get(`${prefix}-timestamp`);
  const signatures = headers.get(`${prefix}-signature`);
  if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / SECOND - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (key.length < 16) return false;
  const digest = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signatures.split(" ").some((signature) => {
    if (!signature.startsWith("v1,")) return false;
    const candidate = Buffer.from(signature.slice(3), "base64");
    return candidate.length === digest.length && timingSafeEqual(digest, candidate);
  });
}
