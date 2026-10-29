import type { SettingsScope } from "@rakazo/contracts";
import {
  ensureAiDataConsent,
  readVoiceAudio,
  readVoiceError,
  requestDeadline,
  toUtterances,
  VOICE_RESPONSE_TIMEOUT_MS,
  withAbort,
} from "@rakazo/core";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { File, Paths } from "expo-file-system";
import type * as ExpoSpeech from "expo-speech";
import { Platform } from "react-native";
import { promptAiConsent } from "./ai-consent";
import type { ApiRequestContext } from "./api";
import { aiConsentCoalesceKey, captureApiRequestContext, rpc } from "./api";
import { voiceForBot } from "./bot-voices";
import { loadDeviceVoiceEnabled } from "./device-voice";
import { t } from "./i18n";
import { errorText, voiceAccountErrorText } from "./user-error";

/** Who is speaking, for the dock: it is mounted outside any one thread's bot list. */
export type PlaybackSpeaker = { name?: string; color?: string };
/** Who started a speech, so their Stop call reaches only their own playback. */
export type SpeechOwner = symbol;

/** A unique owner for the speech one surface is about to start, e.g. the current call. */
export function createSpeechOwner(): SpeechOwner {
  return Symbol("SpeechOwner");
}

type SpeechOptions = {
  /** Which copy of the voice settings to use; omitted means whichever applies in the space. */
  scope?: SettingsScope;
  voiceId?: string;
  botId?: string;
  messageId?: string;
  speaker?: PlaybackSpeaker;
  /** Tags this speech for its starter, so stopSpeaking(owner) cuts only this playback. */
  owner?: SpeechOwner;
};

// Playback status lets a persistent mini-player show and control what's speaking, without every
// screen re-deriving state from the speak calls below.

export type VoicePlaybackStatus = "idle" | "playing" | "paused";
export type VoicePlaybackState = {
  status: VoicePlaybackStatus;
  botId?: string;
  /** The thread message this clip was spoken from, when playback started from one. */
  messageId?: string;
  /** False when the active engine (Android on-device voice) can only stop, not pause. */
  canPause: boolean;
  speaker?: PlaybackSpeaker;
};
type VoiceControl = { pause(): void; resume(): void; stop(): void };

const IDLE_PLAYBACK: VoicePlaybackState = { status: "idle", canPause: false };
let playback: VoicePlaybackState = IDLE_PLAYBACK;
let activeControl: VoiceControl | null = null;
const playbackListeners = new Set<() => void>();

// The speaker is remembered per bot rather than threaded through every state
// change below: pause, resume and the device-voice path all rebuild the state.
let announcedSpeaker: { botId: string; speaker: PlaybackSpeaker } | undefined;

function setPlayback(next: VoicePlaybackState, control: VoiceControl | null) {
  playback =
    next.botId && announcedSpeaker?.botId === next.botId
      ? { ...next, speaker: announcedSpeaker.speaker }
      : next;
  activeControl = control;
  for (const listener of playbackListeners) listener();
}

export function getVoicePlaybackState(): VoicePlaybackState {
  return playback;
}

export function subscribeVoicePlayback(listener: () => void): () => void {
  playbackListeners.add(listener);
  return () => playbackListeners.delete(listener);
}

export function pauseVoicePlayback(): void {
  activeControl?.pause();
}

export function resumeVoicePlayback(): void {
  activeControl?.resume();
}

export function stopVoicePlayback(): void {
  // Bump even when nothing is audible yet. The next queued message may already
  // be preparing, with no player for Stop to reach.
  playbackEpoch += 1;
  speechQueue = [];
  activeControl?.stop();
}

/** Cuts the reply off mid-sentence, for a caller who talked over it. */
export function stopSpeaking(owner?: SpeechOwner): void {
  // An owner's stop reaches only its own speech: a hang-up must not cut unrelated
  // playback that has since replaced it.
  if (owner !== undefined && activeSpeechOwner !== owner) return;
  stopVoicePlayback();
}

let playsInBackground = false;

/**
 * A call keeps its replies playing while the screen is off; the microphone
 * foreground service is what keeps the app alive then.
 */
export function setVoiceBackgroundPlayback(enabled: boolean): void {
  playsInBackground = enabled;
}

// Queued playback runs speakText one call at a time, so a single Stop always reaches whatever is
// actually playing right now.

export type SpeechQueueItem = SpeechOptions & { text: string };

let speechQueue: SpeechQueueItem[] = [];
/** Invalidates in-flight speak calls. Stop and a new speak or queue each bump it. */
let playbackEpoch = 0;
/** The owner of the speech holding the current epoch, replaced as each new speech begins. */
let activeSpeechOwner: SpeechOwner | undefined;

function isCurrentSpeech(epoch: number): boolean {
  return epoch === playbackEpoch;
}

function beginSpeech(owner?: SpeechOwner): number {
  playbackEpoch += 1;
  speechQueue = [];
  // Own the epoch before the first await, so a stale owner cannot stop this preparation.
  activeSpeechOwner = owner;
  // Replacing activeControl leaves the previous player running.
  activeControl?.stop();
  return playbackEpoch;
}

function releasePlayback(epoch: number, stillOwner: boolean, keepForQueue: boolean): void {
  if (!stillOwner || !isCurrentSpeech(epoch)) return;
  // The next queued message is about to prepare. Idle here hides the dock for that gap.
  if (keepForQueue && speechQueue.length > 0) return;
  setPlayback(IDLE_PLAYBACK, null);
}

/**
 * Speaks each item in order; stops early if stopVoicePlayback() clears the
 * queue. Resolves to whether the first item was spoken, so a caller can tell
 * the user when no voice is set up.
 */
export async function speakQueue(items: SpeechQueueItem[]): Promise<boolean> {
  const epoch = beginSpeech();
  speechQueue = items;
  return advanceSpeechQueue(epoch);
}

async function advanceSpeechQueue(epoch: number): Promise<boolean> {
  // A newer Play or Stop owns the outcome. False would look like "no voice".
  if (!isCurrentSpeech(epoch)) return true;
  const next = speechQueue.shift();
  if (!next) return false;
  const { text, ...opts } = next;
  const spoken = await speakPrepared(text, opts, epoch);
  if (!isCurrentSpeech(epoch)) return true;
  if (spoken && speechQueue.length > 0) await advanceSpeechQueue(epoch);
  return spoken;
}

export async function speakText(text: string, opts: SpeechOptions = {}): Promise<boolean> {
  return speakPrepared(text, opts, beginSpeech(opts.owner));
}

async function speakPrepared(text: string, opts: SpeechOptions, epoch: number): Promise<boolean> {
  if (!isCurrentSpeech(epoch)) return false;
  // Each queued item owns the epoch while it prepares and plays.
  activeSpeechOwner = opts.owner;
  announcedSpeaker =
    opts.botId && opts.speaker ? { botId: opts.botId, speaker: opts.speaker } : undefined;
  // Stop has to work before a player exists. Pause stays hidden until one does.
  const prepareControl: VoiceControl = {
    pause() {},
    resume() {},
    stop() {
      setPlayback(IDLE_PLAYBACK, null);
    },
  };
  setPlayback(
    { status: "playing", botId: opts.botId, messageId: opts.messageId, canPause: false },
    prepareControl,
  );
  try {
    let useDeviceVoice = false;
    try {
      useDeviceVoice = await loadDeviceVoiceEnabled();
    } catch {
      // A read failure must not be treated as "off": that would send reply text
      // through hosted voice after the user opted for on-device only.
      useDeviceVoice = true;
    }
    if (!isCurrentSpeech(epoch)) return false;
    if (useDeviceVoice) {
      const spoken = await speakOnDevice(text, opts.botId, opts.messageId, epoch);
      if (!isCurrentSpeech(epoch)) return false;
      if (!spoken && playback.status !== "idle") setPlayback(IDLE_PLAYBACK, null);
      return spoken;
    }
    const requestContext = await captureApiRequestContext();
    if (!isCurrentSpeech(epoch)) return false;
    const prepared = await rpc(
      "voice/prepare",
      { text, voiceId: opts.voiceId, botId: opts.botId, scope: opts.scope },
      { requestContext },
    );
    if (!isCurrentSpeech(epoch)) return false;
    if (!prepared.ready) {
      if (playback.status !== "idle") setPlayback(IDLE_PLAYBACK, null);
      return false;
    }

    const generation = startHostedSpeechSession();
    // The prepare control only owns the dock; stopping it would hide Stop.
    if (activeControl !== prepareControl) activeControl?.stop();
    if (!isCurrentSpeech(epoch)) return false;
    const session = new HostedSession(generation);
    const control: VoiceControl = {
      pause: () => {
        session.pause();
        setPlayback(
          { status: "paused", botId: opts.botId, messageId: opts.messageId, canPause: true },
          control,
        );
      },
      resume: () => {
        session.resume();
        setPlayback(
          { status: "playing", botId: opts.botId, messageId: opts.messageId, canPause: true },
          control,
        );
      },
      stop: () => {
        session.stop();
        setPlayback(IDLE_PLAYBACK, null);
      },
    };
    setPlayback(
      { status: "playing", botId: opts.botId, messageId: opts.messageId, canPause: true },
      control,
    );
    const utterances = prepared.utterances;
    // Render one clip ahead; failures ride as values so an abandoned prefetch never rejects unhandled.
    type Rendered = { audio: Uint8Array; error?: never } | { audio?: never; error: unknown };
    const render = (text: string): Promise<Rendered> =>
      renderUtterance(text, opts, requestContext).then(
        (audio) => ({ audio }),
        (error: unknown) => ({ error }),
      );
    let finished = false;
    try {
      let next: Promise<Rendered> | null =
        utterances.length > 0 ? render(utterances[0] ?? "") : null;
      for (let i = 0; i < utterances.length; i += 1) {
        if (session.isStopped || !isCurrentSpeech(epoch)) break;
        const current = next;
        next = i + 1 < utterances.length ? render(utterances[i + 1] ?? "") : null;
        if (!current) break;
        const rendered = await current;
        if ("error" in rendered) throw rendered.error;
        if (session.isStopped || !isCurrentSpeech(epoch)) break;
        await playSpeechClip(rendered.audio, session);
      }
      finished = !session.isStopped && isCurrentSpeech(epoch);
    } finally {
      releasePlayback(epoch, isCurrentHostedSpeechSession(generation), finished);
    }
    return true;
  } finally {
    // A thrown or abandoned prepare must not leave the dock up. A newer Play
    // has already replaced this control.
    if (isCurrentSpeech(epoch) && activeControl === prepareControl) {
      setPlayback(IDLE_PLAYBACK, null);
    }
  }
}

let deviceSpeechSession = 0;

function startDeviceSpeechSession(): number {
  return ++deviceSpeechSession;
}

function isCurrentDeviceSpeechSession(session: number): boolean {
  return session === deviceSpeechSession;
}

export async function speakWithDeviceVoice(
  text: string,
  botId?: string,
  messageId?: string,
): Promise<boolean> {
  return speakOnDevice(text, botId, messageId);
}

async function speakOnDevice(
  text: string,
  botId?: string,
  messageId?: string,
  epoch?: number,
): Promise<boolean> {
  const utterances = toUtterances(text);
  if (utterances.length === 0) return false;
  const mine = epoch ?? beginSpeech();
  if (!isCurrentSpeech(mine)) return false;
  // Claim the session before importing so a newer call cannot start during
  // that await and then overlap this call's remaining chunks.
  const session = startDeviceSpeechSession();
  const Speech = await loadExpoSpeech();
  // Each bot keeps its own offline voice; without one the engine's default speaks.
  const voice = botId ? await voiceForBot(botId).catch(() => undefined) : undefined;
  if (!isCurrentDeviceSpeechSession(session) || !isCurrentSpeech(mine)) return true;
  await Speech.stop();
  if (!isCurrentDeviceSpeechSession(session) || !isCurrentSpeech(mine)) return true;

  // Android's TextToSpeech engine has no pause/resume, only stop; iOS's does.
  // Feature-detect rather than trust the platform alone: support has moved
  // across expo-speech versions, and a missing method must not throw here.
  const pausable = Speech as unknown as {
    pause?: () => void | Promise<void>;
    resume?: () => void | Promise<void>;
  };
  const canPause =
    Platform.OS === "ios" &&
    typeof pausable.pause === "function" &&
    typeof pausable.resume === "function";
  if (!isCurrentDeviceSpeechSession(session) || !isCurrentSpeech(mine)) return true;
  const control: VoiceControl = {
    pause: () => {
      if (!canPause) return;
      void pausable.pause?.();
      setPlayback({ status: "paused", botId, messageId, canPause }, control);
    },
    resume: () => {
      if (!canPause) return;
      void pausable.resume?.();
      setPlayback({ status: "playing", botId, messageId, canPause }, control);
    },
    stop: () => {
      deviceSpeechSession += 1;
      void Speech.stop();
      setPlayback(IDLE_PLAYBACK, null);
    },
  };
  setPlayback({ status: "playing", botId, messageId, canPause }, control);
  let finished = false;
  try {
    for (const utterance of utterances) {
      if (!isCurrentDeviceSpeechSession(session) || !isCurrentSpeech(mine)) return true;
      await speakOneUtterance(Speech, utterance, voice);
    }
    finished = isCurrentDeviceSpeechSession(session) && isCurrentSpeech(mine);
    return true;
  } finally {
    releasePlayback(mine, isCurrentDeviceSpeechSession(session), finished);
  }
}

async function loadExpoSpeech(): Promise<typeof ExpoSpeech> {
  let Speech: Partial<typeof ExpoSpeech>;
  try {
    Speech = await import("expo-speech");
  } catch (error) {
    throw error instanceof Error ? error : new Error(t("Could not play that clip."));
  }
  if (typeof Speech.speak !== "function" || typeof Speech.stop !== "function") {
    throw new Error(t("Could not play that clip."));
  }
  return Speech as typeof ExpoSpeech;
}

function speakOneUtterance(Speech: typeof ExpoSpeech, text: string, voice?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Only offline voices are assigned; without one, use the engine default.
    Speech.speak(text, {
      ...(voice ? { voice } : {}),
      onDone: () => resolve(),
      // Speech.stop() reports onStopped, not onDone.
      onStopped: () => resolve(),
      onError: (error) => reject(error instanceof Error ? error : new Error(String(error))),
    });
  });
}

export async function speakUtterance(
  text: string,
  opts: SpeechOptions & { requestContext?: ApiRequestContext } = {},
): Promise<Uint8Array> {
  const requestContext = opts.requestContext ?? (await captureApiRequestContext());
  await ensureAiDataConsent({
    uses: ["voice"],
    status: () =>
      rpc(
        "aiConsent/status",
        { uses: ["voice"], ...(opts.scope ? { settingsScope: opts.scope } : {}) },
        { requestContext },
      ),
    prompt: promptAiConsent,
    allow: (input) =>
      rpc("aiConsent/allow", opts.scope ? { ...input, settingsScope: opts.scope } : input, {
        requestContext,
      }),
    coalesceKey: aiConsentCoalesceKey(requestContext),
  });
  return renderUtterance(text, opts, requestContext);
}

async function renderUtterance(
  text: string,
  opts: SpeechOptions,
  requestContext: ApiRequestContext,
): Promise<Uint8Array> {
  const deadline = requestDeadline(VOICE_RESPONSE_TIMEOUT_MS, "Voice request timed out.");
  try {
    const res = await withAbort(
      fetch(`${requestContext.apiBase}/api/voice/speak`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "rakazo://",
          ...requestContext.headers,
        },
        body: JSON.stringify({
          text,
          voiceId: opts.voiceId,
          botId: opts.botId,
          scope: opts.scope,
        }),
        signal: deadline.signal,
      }),
      deadline.signal,
      "Voice request aborted.",
    ).catch((error: unknown) => {
      throw deadline.signal.aborted
        ? error
        : new Error(errorText(error, t("Could not speak that.")));
    });
    if (!res.ok) {
      const body = await readVoiceError(res, deadline.signal);
      throw new Error(
        voiceAccountErrorText(body) ?? errorText(body.error ?? "", t("Could not speak that.")),
      );
    }
    return await readVoiceAudio(res, deadline.signal);
  } finally {
    deadline.dispose();
  }
}

// Hosted playback shares one HostedSession across a speakText call's utterances, so
// Pause/Resume/Stop keep working across the gap between them.

let hostedSpeechSession = 0;

function startHostedSpeechSession(): number {
  return ++hostedSpeechSession;
}

function isCurrentHostedSpeechSession(session: number): boolean {
  return session === hostedSpeechSession;
}

type HostedPlayerHandle = { pause(): void; resume(): void; stopNow(): void };

class HostedSession {
  private paused = false;
  private stopped = false;
  private player: HostedPlayerHandle | null = null;

  constructor(private readonly generation: number) {}

  get isStopped(): boolean {
    return this.stopped || !isCurrentHostedSpeechSession(this.generation);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  setPlayer(player: HostedPlayerHandle | null): void {
    this.player = player;
    if (player && this.paused) player.pause();
  }

  pause(): void {
    this.paused = true;
    this.player?.pause();
  }

  resume(): void {
    this.paused = false;
    this.player?.resume();
  }

  stop(): void {
    this.stopped = true;
    this.player?.stopNow();
  }
}

/** Hosted voices send MP3; a server that renders speech itself (macOS) sends WAV. */
export function speechClipType(bytes: Uint8Array): { mimeType: string; extension: string } {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE"
    ? { mimeType: "audio/wav", extension: "wav" }
    : { mimeType: "audio/mpeg", extension: "mp3" };
}

export async function playSpeechClip(bytes: Uint8Array, session?: HostedSession): Promise<void> {
  const AudioCtor = (globalThis as { Audio?: typeof Audio }).Audio;
  if (typeof AudioCtor === "function") {
    await playWithHtmlAudio(AudioCtor, bytes, session);
    return;
  }
  await playWithNativeAudio(bytes, session);
}

async function playWithHtmlAudio(
  AudioCtor: typeof Audio,
  bytes: Uint8Array,
  session?: HostedSession,
): Promise<void> {
  if (session?.isStopped) return;
  const blob = new Blob([new Uint8Array(bytes)], { type: speechClipType(bytes).mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const audio = new AudioCtor(url);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        session?.setPlayer(null);
        if (error) reject(error);
        else resolve();
      };
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error(t("Could not play that clip.")));
      session?.setPlayer({
        pause: () => audio.pause(),
        resume: () => void audio.play().catch(() => undefined),
        stopNow: () => {
          audio.pause();
          finish();
        },
      });
      if (session?.isStopped) {
        finish();
        return;
      }
      if (session?.isPaused) return;
      try {
        void audio
          .play()
          .catch((error: unknown) =>
            finish(error instanceof Error ? error : new Error(t("Could not play that clip."))),
          );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(t("Could not play that clip.")));
      }
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function playWithNativeAudio(bytes: Uint8Array, session?: HostedSession): Promise<void> {
  if (session?.isStopped) return;
  await setAudioModeAsync({
    playsInSilentMode: true,
    interruptionMode: "mixWithOthers",
    shouldPlayInBackground: playsInBackground,
  });
  const file = new File(
    Paths.cache,
    `rakazo-voice-${Date.now()}.${speechClipType(bytes).extension}`,
  );
  file.create({ overwrite: true });
  file.write(bytesToBase64(bytes), { encoding: "base64" });
  const player = createAudioPlayer({ uri: file.uri });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.remove();
        session?.setPlayer(null);
        if (error) reject(error);
        else resolve();
      };
      const armStartupWatchdog = () => {
        timer = setTimeout(() => finish(new Error(t("Could not play that clip."))), 15_000);
      };
      const sub = player.addListener("playbackStatusUpdate", (status) => {
        if (status.error) {
          finish(new Error(status.error));
          return;
        }
        if (status.playbackState === "failed") {
          finish(new Error(t("Could not play that clip.")));
          return;
        }
        if (status.didJustFinish) {
          finish();
          return;
        }
        if (status.playing && status.duration > 0 && !session?.isPaused) {
          clearTimeout(timer);
          timer = setTimeout(
            () => finish(new Error(t("Could not play that clip."))),
            Math.min(120_000, Math.ceil(status.duration * 1000) + 8_000),
          );
        }
      });
      session?.setPlayer({
        pause: () => {
          player.pause();
          // A long pause is not a stalled start. Leaving this timer armed
          // rejects the clip and drops Resume.
          clearTimeout(timer);
          timer = undefined;
        },
        resume: () => {
          player.play();
          if (!timer) armStartupWatchdog();
        },
        stopNow: () => {
          player.pause();
          finish();
        },
      });
      if (session?.isStopped) {
        finish();
        return;
      }
      if (session?.isPaused) return;
      armStartupWatchdog();
      try {
        player.play();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(t("Could not play that clip.")));
      }
    });
  } finally {
    player.release();
    try {
      file.delete();
    } catch {
      // already gone
    }
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
