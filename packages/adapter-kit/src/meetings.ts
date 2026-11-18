import type { MeetingPlatform, MeetingStatus, MeetingTurn } from "@rakazo/contracts";
import type { AdapterDescriptor } from "./types.js";

export interface MeetingJoinRequest {
  sessionId: string;
  meetingUrl: string;
  platform: MeetingPlatform;
  botName: string;
  expiresAt: Date;
  mediaUrl?: string;
  /** The media page can process live speech and reply aloud. Disclose this on joining. */
  liveVoice?: boolean;
}

export interface MeetingObservation {
  externalId: string;
  sessionId?: string;
  status?: MeetingStatus;
  occurredAt: Date;
  recordingId?: string;
  transcriptId?: string;
  error?: "admission" | "capture" | "transcript" | "join";
}

export interface MeetingProvider {
  describe(): AdapterDescriptor<{ platforms: readonly MeetingPlatform[]; offline?: boolean }>;
  join(input: MeetingJoinRequest, signal: AbortSignal): Promise<MeetingObservation>;
  find(sessionId: string, signal: AbortSignal): Promise<MeetingObservation | null>;
  get(externalId: string, signal: AbortSignal): Promise<MeetingObservation | null>;
  leave(externalId: string, signal: AbortSignal): Promise<MeetingObservation | undefined>;
  requestTranscript(
    recordingId: string,
    signal: AbortSignal,
  ): Promise<{ id: string; ready: boolean }>;
  transcriptReady(transcriptId: string, signal: AbortSignal): Promise<boolean>;
  downloadTranscript(
    transcriptId: string,
    signal: AbortSignal,
    options?: { selfName?: string },
  ): Promise<MeetingTurn[]>;
  deleteRecording(recordingId: string, signal: AbortSignal): Promise<void>;
  verifyWebhook(body: string, headers: Headers): MeetingObservation | "ignored" | "invalid";
}

/** A definite rejection, so no meeting participant was created by this request. */
export class MeetingJoinRejected extends Error {
  constructor(readonly retryAfterMs?: number) {
    super("Meeting provider refused the join");
  }
}
