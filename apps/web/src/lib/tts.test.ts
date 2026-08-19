import { describe, expect, it, vi } from "vitest";
import { Speaker } from "./tts.js";

describe("Speaker", () => {
  it("interrupting before audio arrives leaves the speaker idle", async () => {
    const speaker = new Speaker();
    vi.spyOn(
      speaker as unknown as { prepare: () => Promise<string[]> },
      "prepare",
    ).mockImplementation(() => new Promise(() => undefined));
    const pending = speaker.speak("Hello there.", { messageId: "m1" });
    speaker.stop();
    await pending;
    expect(speaker.state.status).toBe("idle");
  });

  it("resolves with an error snapshot instead of rejecting", async () => {
    const speaker = new Speaker();
    vi.spyOn(
      speaker as unknown as { prepare: () => Promise<string[]> },
      "prepare",
    ).mockRejectedValue(new Error("ElevenLabs rejected that key."));
    await expect(speaker.speak("Hi there.")).resolves.toBeUndefined();
    expect(speaker.state.error).toBe("ElevenLabs rejected that key.");
  });
});
