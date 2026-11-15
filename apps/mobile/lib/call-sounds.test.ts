import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { deleteItemAsync, getItemAsync, setItemAsync } from "expo-secure-store";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CALL_GREETING_KEY,
  loadCallGreetingEnabled,
  playCallCue,
  preloadWaitSound,
  releaseWaitSound,
  saveCallGreetingEnabled,
  startWaitSound,
  stopWaitSound,
} from "./call-sounds";

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
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
const call = vi.hoisted(() => ({ active: false }));
vi.mock("./voice", () => ({
  activateVoiceAudio: vi.fn(async () => undefined),
  callAudioActive: () => call.active,
}));
vi.mock("expo-audio", () => ({
  createAudioPlayer: vi.fn(),
  setAudioModeAsync: vi.fn(),
}));

const player = {
  volume: 1,
  play: vi.fn(),
  pause: vi.fn(),
  release: vi.fn(),
  addListener: vi.fn(() => ({ remove: vi.fn() })),
};

/** A player for one waiting unit that can report it played to the end. */
function waitUnitPlayer() {
  const listeners = new Set<(status: { didJustFinish: boolean }) => void>();
  return {
    volume: 1,
    play: vi.fn(),
    release: vi.fn(),
    addListener: (_event: string, listener: (status: { didJustFinish: boolean }) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    finish: () => {
      for (const listener of [...listeners]) listener({ didJustFinish: true });
    },
  };
}

/** Every player the waiting sound creates, in order. */
function waitPlayers() {
  const players: Array<ReturnType<typeof waitUnitPlayer>> = [];
  vi.mocked(createAudioPlayer).mockImplementation(() => {
    const unit = waitUnitPlayer();
    players.push(unit);
    return unit as unknown as ReturnType<typeof createAudioPlayer>;
  });
  return players;
}

/** How many of these players have not been released. */
const held = (players: Array<ReturnType<typeof waitUnitPlayer>>) =>
  players.filter((unit) => unit.release.mock.calls.length === 0).length;

beforeEach(() => {
  vi.clearAllMocks();
  call.active = false;
  vi.mocked(getItemAsync).mockResolvedValue(null);
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

it("greets on calls until the greeting is turned off on this device", async () => {
  expect(await loadCallGreetingEnabled()).toBe(true);
  await saveCallGreetingEnabled(false);
  expect(setItemAsync).toHaveBeenCalledWith(CALL_GREETING_KEY, "0");
  vi.mocked(getItemAsync).mockResolvedValue("0");
  expect(await loadCallGreetingEnabled()).toBe(false);
  await saveCallGreetingEnabled(true);
  expect(deleteItemAsync).toHaveBeenCalledWith(CALL_GREETING_KEY);
});

it.each(["start", "end"] as const)(
  "plays the %s cue during a call without changing the audio mode",
  async (cue) => {
    call.active = true;
    const playing = playCallCue(cue);
    await vi.advanceTimersByTimeAsync(1600);
    await playing;

    expect(player.play).toHaveBeenCalledOnce();
    expect(player.release).toHaveBeenCalledOnce();
    expect(setAudioModeAsync).not.toHaveBeenCalled();
    expect(createAudioPlayer).toHaveBeenCalledWith(expect.anything(), {
      keepAudioSessionActive: true,
    });
  },
);

it("lets a cue played outside a call release the audio session", async () => {
  const playing = playCallCue("start");
  await vi.advanceTimersByTimeAsync(1600);
  await playing;

  expect(createAudioPlayer).toHaveBeenCalledWith(expect.anything(), {
    keepAudioSessionActive: false,
  });
});

it("plays waiting audio without changing the active recognition audio mode", async () => {
  const playing = startWaitSound();
  await vi.advanceTimersByTimeAsync(0);
  expect(player.play).toHaveBeenCalledOnce();
  expect(setAudioModeAsync).not.toHaveBeenCalled();
  expect(createAudioPlayer).toHaveBeenCalledWith(expect.anything(), {
    keepAudioSessionActive: true,
  });

  releaseWaitSound();
  await playing;
});

it("loads one waiting unit at call start instead of every pattern", async () => {
  const players = waitPlayers();
  await preloadWaitSound();
  expect(players).toHaveLength(1);

  const playing = startWaitSound();
  await vi.advanceTimersByTimeAsync(0);
  expect(players[0]?.play).toHaveBeenCalledOnce();
  expect(players).toHaveLength(2);

  releaseWaitSound();
  await playing;
});

it("holds only the playing unit and the next one, and plays each straight after the last", async () => {
  const players = waitPlayers();
  const playing = startWaitSound();
  await vi.advanceTimersByTimeAsync(0);
  expect(players).toHaveLength(2);

  for (let unit = 0; unit < 4; unit += 1) {
    expect(players[unit + 1]?.play).not.toHaveBeenCalled();
    players[unit]?.finish();
    // No timer runs between the units, so nothing can open a gap.
    await vi.advanceTimersByTimeAsync(0);
    expect(players[unit]?.release).toHaveBeenCalledOnce();
    expect(players[unit + 1]?.play).toHaveBeenCalledOnce();
    expect(held(players)).toBe(2);
  }

  releaseWaitSound();
  await playing;
  expect(held(players)).toBe(0);
});

it("fades out the playing unit and keeps the next one for the following turn", async () => {
  const players = waitPlayers();
  const first = startWaitSound();
  await vi.advanceTimersByTimeAsync(0);
  stopWaitSound();
  await first;
  expect(players[0]?.release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(150);
  expect(players[0]?.volume).toBe(0);
  expect(players[0]?.release).toHaveBeenCalledOnce();
  expect(held(players)).toBe(1);

  const second = startWaitSound();
  await vi.advanceTimersByTimeAsync(0);
  expect(players[1]?.play).toHaveBeenCalledOnce();
  expect(players).toHaveLength(3);

  releaseWaitSound();
  await second;
  expect(held(players)).toBe(0);
});

it("ends a unit still playing from an earlier start instead of overlapping it", async () => {
  const players = waitPlayers();
  const first = startWaitSound();
  await vi.advanceTimersByTimeAsync(0);
  const second = startWaitSound();
  await first;
  await vi.advanceTimersByTimeAsync(0);

  expect(players[0]?.release).toHaveBeenCalledOnce();
  expect(players[1]?.play).toHaveBeenCalledOnce();
  expect(held(players)).toBe(2);

  releaseWaitSound();
  await second;
  expect(held(players)).toBe(0);
});

it("cancels a cue pending its settings read at hang-up", async () => {
  let resolve!: (value: string | null) => void;
  vi.mocked(getItemAsync).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const playing = playCallCue("start");
  releaseWaitSound();
  resolve(null);
  await playing;
  expect(createAudioPlayer).not.toHaveBeenCalled();
});

it("stops and releases a playing cue immediately at hang-up", async () => {
  const playing = playCallCue("end");
  await vi.advanceTimersByTimeAsync(0);
  expect(player.play).toHaveBeenCalledOnce();
  releaseWaitSound();
  expect(player.pause).toHaveBeenCalledOnce();
  expect(player.release).toHaveBeenCalledOnce();
  await playing;
  expect(player.release).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("still plays a settings preview after call cleanup", async () => {
  releaseWaitSound();
  const playing = playCallCue("start");
  await vi.advanceTimersByTimeAsync(1600);
  await playing;
  expect(player.play).toHaveBeenCalledOnce();
  expect(player.release).toHaveBeenCalledOnce();
});

it("cancels a cue pending its audio import at hang-up", async () => {
  vi.resetModules();
  let finishImport!: () => void;
  let importStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    importStarted = resolve;
  });
  const pendingImport = new Promise<void>((resolve) => {
    finishImport = resolve;
  });
  vi.doMock("expo-audio", async () => {
    importStarted();
    await pendingImport;
    return { createAudioPlayer, setAudioModeAsync };
  });
  try {
    const sounds = await import("./call-sounds");
    const playing = sounds.playCallCue("start");
    await started;
    sounds.releaseWaitSound();
    finishImport();
    await playing;
    expect(createAudioPlayer).not.toHaveBeenCalled();
  } finally {
    vi.doMock("expo-audio", () => ({ createAudioPlayer, setAudioModeAsync }));
    vi.resetModules();
  }
});
