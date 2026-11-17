import type { AudioPlayer } from "expo-audio";
import * as SecureStore from "expo-secure-store";
import { activateVoiceAudio, callAudioActive } from "./voice";
import { nextWaitUnit } from "./wait-pattern";

export const CALL_SOUNDS_KEY = "rakazo.call-sounds";
export const WAIT_SOUND_KEY = "rakazo.wait-sound";
export const CALL_GREETING_KEY = "rakazo.call-greeting";

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

const CALL_PLAYER = { keepAudioSessionActive: true };

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

export async function loadCallGreetingEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(CALL_GREETING_KEY)) !== "0";
}

export async function saveCallGreetingEnabled(on: boolean): Promise<void> {
  if (on) await SecureStore.deleteItemAsync(CALL_GREETING_KEY);
  else await SecureStore.setItemAsync(CALL_GREETING_KEY, "0");
}

export async function playCallCue(cue: CallCue): Promise<void> {
  const epoch = waitCallEpoch;
  if (!(await loadCallSoundsEnabled().catch(() => true))) return;
  if (epoch !== waitCallEpoch) return;
  const { createAudioPlayer } = await import("expo-audio");
  if (epoch !== waitCallEpoch) return;
  await activateVoiceAudio();
  if (epoch !== waitCallEpoch) return;
  const player = createAudioPlayer(CUE_ASSETS[cue], {
    keepAudioSessionActive: callAudioActive(),
  });
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
    // Not remove(): on Android that keeps the native player and its audio track until GC.
    if (cuePlayers.delete(player)) player.release();
  }
}

const cuePlayers = new Map<AudioPlayer, () => void>();

type QueuedWait = { player: AudioPlayer; pattern: number };

/** Track the played pattern, excluding units that were only queued. */
let lastWaitPattern = 0;
/**
 * The next unit, loading while the current one plays so it starts without a gap. Each loaded
 * player holds an Android audio track, so only this one and the playing one exist at a time.
 */
let waitQueued: QueuedWait | null = null;
/** Invalidate pending playback on start, stop, or release. */
let waitGeneration = 0;
/** Prevent preloads from queueing players after hang-up. */
let waitCallEpoch = 0;
let waitCurrent: AudioPlayer | null = null;
let wakeWait: (() => void) | null = null;
let fade: { timer: ReturnType<typeof setInterval>; player: AudioPlayer } | null = null;

async function queueWaitUnit(epoch: number): Promise<QueuedWait | null> {
  const { createAudioPlayer } = await import("expo-audio");
  if (epoch !== waitCallEpoch) return null;
  if (!waitQueued) {
    const unit = nextWaitUnit(lastWaitPattern);
    const player = createAudioPlayer(WAIT_ASSETS[unit.tone][unit.pattern - 1], CALL_PLAYER);
    waitQueued = { player, pattern: unit.pattern };
  }
  return waitQueued;
}

/** Load the first waiting unit before the first turn. */
export async function preloadWaitSound(): Promise<void> {
  const epoch = waitCallEpoch;
  if (!(await loadWaitSoundEnabled().catch(() => true))) return;
  await queueWaitUnit(epoch);
}

export async function startWaitSound(): Promise<void> {
  // A unit still playing for an earlier turn fades out rather than being left playing.
  stopWaitSound();
  const generation = waitGeneration;
  const epoch = waitCallEpoch;
  if (!(await loadWaitSoundEnabled().catch(() => true))) return;
  if (generation !== waitGeneration || epoch !== waitCallEpoch) return;
  let next = await queueWaitUnit(epoch);
  while (next && generation === waitGeneration) {
    const { player, pattern } = next;
    waitQueued = null;
    endFade();
    waitCurrent = player;
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
    lastWaitPattern = pattern;
    // Queue the next unit during playback.
    next = await queueWaitUnit(epoch);
    await finished;
    // A stopped unit belongs to the fade, and hang-up has already released it.
    if (waitCurrent === player) {
      waitCurrent = null;
      player.release();
    }
  }
}

function endFade(): void {
  if (!fade) return;
  clearInterval(fade.timer);
  fade.player.release();
  fade = null;
}

/** Fade out the playing unit; the queued one stays loaded for the next turn. */
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
    player.release();
  }
  cuePlayers.clear();
  wakeWait?.();
  endFade();
  waitCurrent?.release();
  waitCurrent = null;
  waitQueued?.player.release();
  waitQueued = null;
  lastWaitPattern = 0;
}
