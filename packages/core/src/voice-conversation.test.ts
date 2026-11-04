import { describe, expect, it } from "vitest";
import { VoiceTranscript } from "./voice-conversation.js";

describe("voice transcript", () => {
  it("deduplicates provider events and preserves fragment spacing and timing", () => {
    const transcript = new VoiceTranscript();
    const first = {
      type: "transcript" as const,
      id: "1",
      role: "user" as const,
      text: "Hello",
      startMs: 0,
      endMs: 10,
    };
    transcript.append(first);
    transcript.append(first);
    transcript.append({ ...first, id: "2", text: " there", startMs: 10, endMs: 20 });
    expect(transcript.entries()).toEqual([
      { role: "user", text: "Hello there", startMs: 0, endMs: 20 },
    ]);
    expect(transcript.takeRequest()).toBe("Hello there");
    expect(transcript.takeRequest()).toBe("");
  });
  it("keeps overlapping speakers separate and does not submit assistant speech", () => {
    const transcript = new VoiceTranscript();
    transcript.append({
      type: "transcript",
      id: "1",
      role: "user",
      text: "Look up",
      startMs: 0,
      endMs: 20,
    });
    transcript.append({
      type: "transcript",
      id: "2",
      role: "bot",
      text: "Sure",
      startMs: 10,
      endMs: 30,
    });
    transcript.append({
      type: "transcript",
      id: "3",
      role: "user",
      text: " trains",
      startMs: 20,
      endMs: 40,
    });
    expect(transcript.takeRequest()).toBe("Look up trains");
    expect(transcript.entries()).toHaveLength(2);
  });
});
