import { describe, expect, it, vi } from "vitest";
import { voiceDeadline } from "./voice-http.js";

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
    await vi.waitFor(() => expect(combined.aborted).toBe(true));
  });
});
