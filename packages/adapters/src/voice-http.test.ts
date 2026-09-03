import { describe, expect, it } from "vitest";
import { speechUploadName, voiceDeadline } from "./voice-http.js";

describe("voiceDeadline", () => {
  it("aborts when the client signal aborts", () => {
    const client = new AbortController();
    const combined = voiceDeadline(client.signal, 20_000);
    expect(combined.aborted).toBe(false);
    client.abort();
    expect(combined.aborted).toBe(true);
  });

  it("aborts when the deadline elapses even if the client stays connected", async () => {
    const combined = voiceDeadline(new AbortController().signal, 1);
    await new Promise<void>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("deadline did not abort")), 1_000);
      combined.addEventListener(
        "abort",
        () => {
          clearTimeout(guard);
          resolve();
        },
        { once: true },
      );
    });
    expect(combined.aborted).toBe(true);
  });
});

describe("speechUploadName", () => {
  it("keeps webm recordings as webm even when they name an opus codec", () => {
    expect(speechUploadName("audio/webm;codecs=opus")).toBe("speech.webm");
  });

  it("maps Firefox ogg capture to an ogg filename", () => {
    expect(speechUploadName("audio/ogg; codecs=opus")).toBe("speech.ogg");
  });
});
