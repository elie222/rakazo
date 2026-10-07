import type { AudioPlayer } from "expo-audio";
import * as SecureStore from "expo-secure-store";
import type { WaitTone, WaitUnit } from "./wait-pattern";
import { nextWaitUnit, WAIT_PATTERNS } from "./wait-pattern";

export const CALL_SOUNDS_KEY = "rakazo.call-sounds";
export const WAIT_SOUND_KEY = "rakazo.wait-sound";

export type CallCue = "start" | "end";

const CUE_ASSETS: Record<CallCue, number> = {
  start: require("../assets/sounds/warm-start.wav"),
  end: require("../assets/sounds/warm-end.wav"),
};

/** Ten patterns in two tones; pattern N is the same tune in both. */
const WAIT_ASSETS = {
  wood: [
    require("../assets/sounds/wait-wood-01.wav"),
    require("../assets/sounds/wait-wood-02.wav"),
    require("../assets/sounds/wait-wood-03.wav"),
    require("../assets/sounds/wait-wood-04.wav"),
    require("../assets/sounds/wait-wood-05.wav"),
    require("../assets/sounds/wait-wood-06.wav"),
    require("../assets/sounds/wait-wood-07.wav"),
    require("../assets/sounds/wait-wood-08.wav"),
    require("../assets/sounds/wait-wood-09.wav"),
    require("../assets/sounds/wait-wood-10.wav"),
  ],
  hollow: [
    require("../assets/sounds/wait-hollow-01.wav"),
    require("../assets/sounds/wait-hollow-02.wav"),
    require("../assets/sounds/wait-hollow-03.wav"),
    require("../assets/sounds/wait-hollow-04.wav"),
    require("../assets/sounds/wait-hollow-05.wav"),
    require("../assets/sounds/wait-hollow-06.wav"),
    require("../assets/sounds/wait-hollow-07.wav"),
    require("../assets/sounds/wait-hollow-08.wav"),
    require("../assets/sounds/wait-hollow-09.wav"),
    require("../assets/sounds/wait-hollow-10.wav"),
  ],
} as const;

/** A cue never holds the call up for longer than this, even if playback never reports done. */
const CUE_MAX_MS = 1600;
const WAIT_FADE_MS = 150;
const WAIT_FADE_STEPS = 6;

/** On unless the caller turned them off. */
export async function loadCallSoundsEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(CALL_SOUNDS_KEY)) !== "0";
}

export async function saveCallSoundsEnabled(on: boolean): Promise<void> {
  if (on) await SecureStore.deleteItemAsync(CALL_SOUNDS_KEY);
  else await SecureStore.setItemAsync(CALL_SOUNDS_KEY, "0");
}

/** On unless the caller turned it off. */
export async function loadWaitSoundEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(WAIT_SOUND_KEY)) !== "0";
}

export async function saveWaitSoundEnabled(on: boolean): Promise<void> {
  if (on) await SecureStore.deleteItemAsync(WAIT_SOUND_KEY);
  else await SecureStore.setItemAsync(WAIT_SOUND_KEY, "0");
}

/** Plays a call cue to the end, or not at all when the caller turned call sounds off. */
export async function playCallCue(cue: CallCue): Promise<void> {
  if (!(await loadCallSoundsEnabled().catch(() => true))) return;
  const { createAudioPlayer } = await import("expo-audio");
  const player = createAudioPlayer(CUE_ASSETS[cue]);
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CUE_MAX_MS);
      player.addListener("playbackStatusUpdate", (status) => {
        if (!status.didJustFinish) return;
        clearTimeout(timer);
        resolve();
      });
      player.play();
    });
  } finally {
    player.remove();
  }
}

/** The pattern last heard, not merely queued: a stopped wait discards its queued unit. */
let lastWaitPattern = 0;
let waitPlayers: Map<string, AudioPlayer> | null = null;
/** Bumped on every start, stop, and release, so a unit finishing late never chains on. */
let waitGeneration = 0;
/** Bumped at hang-up, so a preload or wait that began during the call caches nothing after. */
let waitCallEpoch = 0;
let waitCurrent: AudioPlayer | null = null;
/** Ends the wait for the playing unit at once when the sound is stopped. */
let wakeWait: (() => void) | null = null;
let fade: { timer: ReturnType<typeof setInterval>; player: AudioPlayer } | null = null;

async function waitPlayer(unit: WaitUnit, epoch: number): Promise<AudioPlayer | null> {
  const { createAudioPlayer } = await import("expo-audio");
  if (epoch !== waitCallEpoch) return null;
  waitPlayers ??= new Map();
  const key = `${unit.tone}-${unit.pattern}`;
  let player = waitPlayers.get(key);
  if (!player) {
    player = createAudioPlayer(WAIT_ASSETS[unit.tone][unit.pattern - 1]);
    waitPlayers.set(key, player);
  }
  return player;
}

/** Loads every waiting unit up front, so no unit waits on disk once a wait begins. */
export async function preloadWaitSound(): Promise<void> {
  const epoch = waitCallEpoch;
  if (!(await loadWaitSoundEnabled().catch(() => true))) return;
  for (const tone of Object.keys(WAIT_ASSETS) as WaitTone[]) {
    for (let pattern = 1; pattern <= WAIT_PATTERNS; pattern += 1) {
      if (!(await waitPlayer({ tone, pattern }, epoch))) return;
    }
  }
}

/** Chains random waiting units until stopWaitSound, unless the caller turned it off. */
export async function startWaitSound(): Promise<void> {
  const generation = ++waitGeneration;
  const epoch = waitCallEpoch;
  if (!(await loadWaitSoundEnabled().catch(() => true))) return;
  let unit = nextWaitUnit(lastWaitPattern);
  let next = await waitPlayer(unit, epoch);
  while (next && generation === waitGeneration) {
    const player = next;
    const playing = unit;
    endFade();
    waitCurrent = player;
    player.volume = 1;
    await player.seekTo(0);
    if (generation !== waitGeneration) return;
    const finished = new Promise<void>((resolve) => {
      const subscription = player.addListener("playbackStatusUpdate", (status) => {
        if (status.didJustFinish) done();
      });
      function done() {
        subscription.remove();
        wakeWait = null;
        resolve();
      }
      wakeWait = done;
    });
    player.play();
    lastWaitPattern = playing.pattern;
    // Choose and load the next unit while this one plays, so the two run back to back.
    unit = nextWaitUnit(lastWaitPattern);
    next = await waitPlayer(unit, epoch);
    await finished;
  }
}

/** Cuts a fade short: the player is silenced now instead of by a timer that may outlive it. */
function endFade(): void {
  if (!fade) return;
  clearInterval(fade.timer);
  fade.player.pause();
  fade.player.volume = 1;
  fade = null;
}

/** Fades the waiting sound out over about 150 ms and drops whatever was queued next. */
export function stopWaitSound(): void {
  waitGeneration += 1;
  wakeWait?.();
  const player = waitCurrent;
  waitCurrent = null;
  if (!player) return;
  endFade();
  let step = 0;
  const timer = setInterval(() => {
    step += 1;
    player.volume = Math.max(0, 1 - step / WAIT_FADE_STEPS);
    if (step >= WAIT_FADE_STEPS) endFade();
  }, WAIT_FADE_MS / WAIT_FADE_STEPS);
  fade = { timer, player };
}

/** Frees the preloaded units when the call ends. */
export function releaseWaitSound(): void {
  waitGeneration += 1;
  waitCallEpoch += 1;
  wakeWait?.();
  endFade();
  waitCurrent = null;
  lastWaitPattern = 0;
  for (const player of waitPlayers?.values() ?? []) player.remove();
  waitPlayers = null;
}
