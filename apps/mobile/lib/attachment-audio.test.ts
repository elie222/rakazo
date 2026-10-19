import { isAttachmentAudioMimeType } from "@rakazo/contracts";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("expo-audio", () => ({ createAudioPlayer: mocks.create }));

import { createAttachmentAudioPlayer } from "./attachment-audio";

let listener:
  | ((status: {
      playing: boolean;
      duration: number;
      currentTime: number;
      didJustFinish: boolean;
      playbackState?: string;
      error?: string;
    }) => void)
  | undefined;
const remove = vi.fn();
const player = {
  playing: false,
  play: vi.fn(),
  pause: vi.fn(),
  release: vi.fn(),
  seekTo: vi.fn(),
  addListener: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  listener = undefined;
  player.playing = false;
  player.play.mockImplementation(() => {
    player.playing = true;
  });
  player.pause.mockImplementation(() => {
    player.playing = false;
  });
  player.seekTo.mockResolvedValue(undefined);
  player.addListener.mockImplementation((_event, callback) => {
    listener = callback;
    return { remove };
  });
  mocks.create.mockReturnValue(player);
});
it("classifies only the four supported audio types on mobile", () => {
  for (const mime of ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"])
    expect(isAttachmentAudioMimeType(mime)).toBe(true);
  expect(isAttachmentAudioMimeType("audio/flac")).toBe(false);
});
it("downloads only on play, pauses/resumes, and releases the native player", async () => {
  const load = vi.fn().mockResolvedValue("file:///clip.mp3");
  const state = vi.fn();
  const control = createAttachmentAudioPlayer(load, state);
  expect(load).not.toHaveBeenCalled();
  await control.toggle();
  expect(mocks.create).toHaveBeenCalledWith({ uri: "file:///clip.mp3" });
  expect(player.play).toHaveBeenCalledTimes(1);
  listener?.({ playing: true, currentTime: 1, duration: 4, didJustFinish: false });
  expect(state).toHaveBeenLastCalledWith(
    expect.objectContaining({ currentTime: 1, duration: 4, playing: true }),
  );
  await control.toggle();
  expect(player.pause).toHaveBeenCalledTimes(1);
  await control.toggle();
  expect(player.play).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledTimes(1);
  control.dispose();
  expect(remove).toHaveBeenCalledTimes(1);
  expect(player.release).toHaveBeenCalledTimes(1);
});
it("rewinds a completed clip before replay", async () => {
  const control = createAttachmentAudioPlayer(async () => "file:///clip.wav", vi.fn());
  await control.toggle();
  player.playing = false;
  listener?.({ playing: false, currentTime: 4, duration: 4, didJustFinish: true });
  await control.toggle();
  expect(player.seekTo).toHaveBeenCalledWith(0);
  expect(player.play).toHaveBeenCalledTimes(2);
  control.dispose();
});
it("suppresses duplicate downloads and never plays after unmount", async () => {
  let resolve!: (uri: string) => void;
  const load = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const state = vi.fn();
  const control = createAttachmentAudioPlayer(load, state);
  const first = control.toggle();
  await control.toggle();
  expect(load).toHaveBeenCalledTimes(1);
  control.dispose();
  const calls = state.mock.calls.length;
  resolve("file:///clip.ogg");
  await first;
  expect(mocks.create).not.toHaveBeenCalled();
  expect(state).toHaveBeenCalledTimes(calls);
});
it("reports download failure without native playback and can retry", async () => {
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce("file:///clip.m4a");
  const state = vi.fn();
  const control = createAttachmentAudioPlayer(load, state);
  await control.toggle();
  expect(state).toHaveBeenLastCalledWith(expect.objectContaining({ error: true, loading: false }));
  expect(mocks.create).not.toHaveBeenCalled();
  await control.toggle();
  expect(player.play).toHaveBeenCalledTimes(1);
  control.dispose();
});
it("handles a native decode error and releases before retry", async () => {
  const state = vi.fn();
  const control = createAttachmentAudioPlayer(async () => "file:///clip.mp3", state);
  await control.toggle();
  listener?.({
    playing: false,
    currentTime: 0,
    duration: 0,
    didJustFinish: false,
    playbackState: "failed",
  });
  expect(player.release).toHaveBeenCalledTimes(1);
  expect(state).toHaveBeenLastCalledWith(expect.objectContaining({ error: true, playing: false }));
  await control.toggle();
  expect(mocks.create).toHaveBeenCalledTimes(2);
  control.dispose();
});
