import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { playCallCue, releaseWaitSound, startWaitSound } from "./call-sounds";

// Metro resolves bundled audio assets to numeric IDs.
const assets = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(`${process.cwd()}/package.json`);
  const originalLoader = require.extensions[".m4a"];
  require.extensions[".m4a"] = (assetModule) => {
    assetModule.exports = 1;
  };
  return { require, originalLoader };
});
vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(async () => null) }));
vi.mock("expo-audio", () => ({
  createAudioPlayer: vi.fn(),
  setAudioModeAsync: vi.fn(),
}));

const player = {
  volume: 1,
  play: vi.fn(),
  pause: vi.fn(),
  remove: vi.fn(),
  seekTo: vi.fn(async () => undefined),
  addListener: vi.fn(() => ({ remove: vi.fn() })),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.mocked(createAudioPlayer).mockReturnValue(
    player as unknown as ReturnType<typeof createAudioPlayer>,
  );
});
afterEach(() => {
  releaseWaitSound();
  vi.useRealTimers();
});
afterAll(() => {
  if (assets.originalLoader) assets.require.extensions[".m4a"] = assets.originalLoader;
  else delete assets.require.extensions[".m4a"];
});

it.each(["start", "end"] as const)(
  "plays the %s cue without changing the audio mode",
  async (cue) => {
    const playing = playCallCue(cue);
    await vi.advanceTimersByTimeAsync(1600);
    await playing;

    expect(player.play).toHaveBeenCalledOnce();
    expect(player.remove).toHaveBeenCalledOnce();
    expect(setAudioModeAsync).not.toHaveBeenCalled();
  },
);

it("plays waiting audio without changing the active recognition audio mode", async () => {
  const playing = startWaitSound();
  await vi.advanceTimersByTimeAsync(0);
  expect(player.play).toHaveBeenCalledOnce();
  expect(setAudioModeAsync).not.toHaveBeenCalled();

  releaseWaitSound();
  await playing;
});
