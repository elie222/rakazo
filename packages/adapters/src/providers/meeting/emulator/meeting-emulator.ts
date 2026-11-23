import type { MeetingJoinRequest, MeetingProvider } from "@rakazo/adapter-kit";

export class MeetingEmulator implements MeetingProvider {
  describe() {
    return {
      id: "emulator",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: {
        offline: true,
        platforms: ["zoom", "google_meet", "microsoft_teams"] as const,
      },
    };
  }

  async join({ sessionId }: MeetingJoinRequest) {
    return { externalId: sessionId, sessionId, status: "joined" as const, occurredAt: new Date() };
  }

  async find(sessionId: string) {
    return { externalId: sessionId, sessionId, status: "joined" as const, occurredAt: new Date() };
  }

  async get(externalId: string) {
    return this.find(externalId);
  }

  async leave(externalId: string) {
    return {
      externalId,
      status: "processing" as const,
      occurredAt: new Date(),
      recordingId: `recording-${externalId}`,
    };
  }

  async requestTranscript(recordingId: string) {
    return { id: `transcript-${recordingId}`, ready: true };
  }

  async transcriptReady() {
    return true;
  }

  async downloadTranscript() {
    return [
      { speaker: "Alex Rivera", startMs: 0, text: "We agreed to send the launch draft on Friday." },
      { speaker: "Sam Chen", startMs: 14200, text: "I will check the final copy." },
    ];
  }

  async deleteRecording() {}

  verifyWebhook() {
    return "invalid" as const;
  }
}
