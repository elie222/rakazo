import type { AudioPlayer } from "expo-audio";
import * as SecureStore from "expo-secure-store";
import type { WaitTone, WaitUnit } from "./wait-pattern";
import { nextWaitUnit, WAIT_PATTERNS } from "./wait-pattern";

export const CALL_SOUNDS_KEY = "rakazo.call-sounds";
export const WAIT_SOUND_KEY = "rakazo.wait-sound";

export type CallCue = "start" | "end";

const CUE_ASSETS: Record<CallCue, number> = {
  start: require("../assets/sounds/warm-start.m4a"),
  end: require("../assets/sounds/warm-end.m4a"),
};

const WAIT_ASSETS = {
  wood: [
    require("../assets/sounds/wait-wood-01.m4a"),
    require("../assets/sounds/wait-wood-02.m4a"),
    require("../assets/sounds/wait-wood-03.m4a"),
    require("../assets/sounds/wait-wood-04.m4a"),
    require("../assets/sounds/wait-wood-05.m4a"),
    require("../assets/sounds/wait-wood-06.m4a"),
    require("../assets/sounds/wait-wood-07.m4a"),
    require("../assets/sounds/wait-wood-08.m4a"),
    require("../assets/sounds/wait-wood-09.m4a"),
    require("../assets/sounds/wait-wood-10.m4a"),
  ],
  hollow: [
    require("../assets/sounds/wait-hollow-01.m4a"),
    require("../assets/sounds/wait-hollow-02.m4a"),
    require("../assets/sounds/wait-hollow-03.m4a"),
    require("../assets/sounds/wait-hollow-04.m4a"),
    require("../assets/sounds/wait-hollow-05.m4a"),
    require("../assets/sounds/wait-hollow-06.m4a"),
    require("../assets/sounds/wait-hollow-07.m4a"),
    require("../assets/sounds/wait-hollow-08.m4a"),
    require("../assets/sounds/wait-hollow-09.m4a"),
    require("../assets/sounds/wait-hollow-10.m4a"),
  ],
} as const;

/** Bound playback when no completion event arrives. */
const CUE_MAX_MS = 1600;
const WAIT_FADE_MS = 150;
const WAIT_FADE_STEPS = 6;

export async function loadCallSoundsEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(CALL_SOUNDS_KEY)) !== "0";
}

export async function saveCallSoundsEnabled(on: boolean): Promise<void> {
  if (on) await SecureStore.deleteItemAsync(CALL_SOUNDS_KEY);
  else await SecureStore.setItemAsync(CALL_SOUNDS_KEY, "0");
}

export async function loadWaitSoundEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(WAIT_SOUND_KEY)) !== "0";
}

export async function saveWaitSoundEnabled(on: boolean): Promise<void> {
  if (on) await SecureStore.deleteItemAsync(WAIT_SOUND_KEY);
  else await SecureStore.setItemAsync(WAIT_SOUND_KEY, "0");
}

export async function playCallCue(cue: CallCue): Promise<void> {
  const epoch = waitCallEpoch;
  if (!(await loadCallSoundsEnabled().catch(() => true))) return;
  if (epoch !== waitCallEpoch) return;
  const { createAudioPlayer } = await import("expo-audio");
  if (epoch !== waitCallEpoch) return;
  const player = createAudioPlayer(CUE_ASSETS[cue]);
  let finish: () => void = () => undefined;
  cuePlayers.set(player, () => finish());
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => finish(), CUE_MAX_MS);
      const subscription = player.addListener("playbackStatusUpdate", (status) => {
        if (status.didJustFinish) finish();
      });
      let finished = false;
      finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        subscription.remove();
        resolve();
      };
      player.play();
    });
  } finally {
    finish();
    if (cuePlayers.delete(player)) player.remove();
  }
}

const cuePlayers = new Map<AudioPlayer, () => void>();

/** Track the played pattern, excluding units that were only queued. */
let lastWaitPattern = 0;
let waitPlayers: Map<string, AudioPlayer> | null = null;
/** Invalidate pending playback on start, stop, or release. */
let waitGeneration = 0;
/** Prevent preloads from caching players after hang-up. */
let waitCallEpoch = 0;
let waitCurrent: AudioPlayer | null = null;
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

/** Preload waiting units before the first turn. */
export async function preloadWaitSound(): Promise<void> {
  const epoch = waitCallEpoch;
  if (!(await loadWaitSoundEnabled().catch(() => true))) return;
  for (const tone of Object.keys(WAIT_ASSETS) as WaitTone[]) {
    for (let pattern = 1; pattern <= WAIT_PATTERNS; pattern += 1) {
      if (!(await waitPlayer({ tone, pattern }, epoch))) return;
    }
  }
}

export async function startWaitSound(): Promise<void> {
  const generation = ++waitGeneration;
  const epoch = waitCallEpoch;
  if (!(await loadWaitSoundEnabled().catch(() => true))) return;
  if (generation !== waitGeneration || epoch !== waitCallEpoch) return;
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
    // Queue the next unit during playback.
    unit = nextWaitUnit(lastWaitPattern);
    next = await waitPlayer(unit, epoch);
    await finished;
  }
}

function endFade(): void {
  if (!fade) return;
  clearInterval(fade.timer);
  fade.player.pause();
  fade.player.volume = 1;
  fade = null;
}

/** Fade out and discard the queued unit. */
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

export function releaseWaitSound(): void {
  waitGeneration += 1;
  waitCallEpoch += 1;
  for (const [player, finish] of cuePlayers) {
    finish();
    player.pause();
    player.remove();
  }
  cuePlayers.clear();
  wakeWait?.();
  endFade();
  waitCurrent = null;
  lastWaitPattern = 0;
  for (const player of waitPlayers?.values() ?? []) player.remove();
  waitPlayers = null;
}
