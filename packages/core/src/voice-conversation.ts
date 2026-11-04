import type { VoiceConversationEvent } from "@rakazo/contracts";

export type VoiceTranscriptEntry = {
  role: "user" | "bot";
  text: string;
  startMs: number;
  endMs: number;
};

/** Display groups only: transcript gaps do not prove a completed conversational turn. */
export class VoiceTranscript {
  private seen = new Set<string>();
  private rows: VoiceTranscriptEntry[] = [];
  private pending = "";
  private chars = 0;
  append(event: Extract<VoiceConversationEvent, { type: "transcript" }>): boolean {
    if (this.seen.has(event.id)) return false;
    if (this.seen.size >= 20000 || this.chars + event.text.length > 200000)
      throw new Error("The call transcript reached its limit. Start a new call.");
    this.seen.add(event.id);
    this.chars += event.text.length;
    if (event.role === "user") this.pending += event.text;
    const row = this.rows.findLast((r) => r.role === event.role);
    if (row && event.startMs >= row.endMs && event.startMs - row.endMs < 1500) {
      row.text += event.text;
      row.endMs = event.endMs;
    } else
      this.rows.push({
        role: event.role,
        text: event.text,
        startMs: event.startMs,
        endMs: event.endMs,
      });
    return true;
  }
  entries(): VoiceTranscriptEntry[] {
    return this.rows.map((row) => ({ ...row }));
  }
  takeRequest(): string {
    const text = this.pending.trim();
    this.pending = "";
    return text;
  }
}
