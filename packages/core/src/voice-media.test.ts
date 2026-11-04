import { expect, it, vi } from "vitest";
import type { VoiceMediaStream } from "./voice-media.js";
import { createVoiceMedia } from "./voice-media.js";

it("releases late microphone permission results after hang-up", async () => {
  let resolve!: (value: { getTracks(): Array<{ enabled: boolean; stop(): void }> }) => void;
  const stop = vi.fn();
  const peerClose = vi.fn();
  const media = createVoiceMedia({
    microphone: () =>
      new Promise<VoiceMediaStream>((r) => {
        resolve = r;
      }),
    peer: () => ({ offer: async () => "offer", answer: async () => {}, close: peerClose }),
    connect: async function* () {
      yield { type: "connected" as const, answerSdp: "answer" };
    },
    event: vi.fn(),
    error: vi.fn(),
  });
  const running = media.start();
  media.close();
  resolve({ getTracks: () => [{ enabled: true, stop }] });
  await running;
  expect(stop).toHaveBeenCalledOnce();
  expect(peerClose).not.toHaveBeenCalled();
});

it("applies the answer, mutes tracks, and cleans up a failed stream", async () => {
  const track = { enabled: true, stop: vi.fn() };
  const close = vi.fn();
  const answer = vi.fn();
  const error = vi.fn();
  let media: ReturnType<typeof createVoiceMedia>;
  media = createVoiceMedia({
    microphone: async () => ({ getTracks: () => [track] }),
    peer: () => ({ offer: async () => "offer", answer, close }),
    connect: async function* () {
      yield { type: "connected" as const, answerSdp: "answer" };
      media.mute(true);
      expect(track.enabled).toBe(false);
      throw new Error("offline");
    },
    event: vi.fn(),
    error,
  });
  await media.start();
  expect(answer).toHaveBeenCalledWith("answer");
  expect(close).toHaveBeenCalledOnce();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledOnce();
});

it("reports a truncated event stream instead of silently leaving a listening UI", async () => {
  const error = vi.fn();
  const media = createVoiceMedia({
    microphone: async () => ({ getTracks: () => [] }),
    peer: () => ({ offer: async () => "offer", answer: async () => {}, close() {} }),
    connect: async function* () {
      yield { type: "connected" as const, answerSdp: "answer" };
    },
    event: vi.fn(),
    error,
  });
  await media.start();
  expect(error).toHaveBeenCalledOnce();
});
