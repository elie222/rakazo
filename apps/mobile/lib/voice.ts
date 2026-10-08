import { ensureAiDataConsent, readBoundedResponseBytes, toUtterances } from "@rakazo/core";
import { File, Paths } from "expo-file-system";
import type * as ExpoSpeech from "expo-speech";
import { Platform } from "react-native";
import { promptAiConsent } from "./ai-consent";
import type { ApiRequestContext } from "./api";
import { aiConsentCoalesceKey, captureApiRequestContext, rpc } from "./api";
import { loadDeviceVoiceEnabled } from "./device-voice";
import { t } from "./i18n";
import { errorText } from "./user-error";

/** Who is speaking, for the dock: it is mounted outside any one thread's bot list. */
export type PlaybackSpeaker = { name?: string; color?: string };
type SpeechOptions = {
  voiceId?: string;
  botId?: string;
  messageId?: string;
  speaker?: PlaybackSpeaker;
};
export const VOICE_RESPONSE_TIMEOUT_MS = 70_000;
export const MAX_VOICE_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_VOICE_ERROR_BYTES = 64 * 1024;

// --- Playback status: lets a persistent mini-player show what's speaking and
// control it, without every screen re-deriving state from the speak calls below.

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
export function stopSpeaking(): void {
  stopVoicePlayback();
}

// --- Sequential playback across several messages: speaking a message plays
// it, then keeps going through the rest of the queue until Stop is pressed or
// the last one finishes. Built on top of speakText, one call at a time, so a
// single Stop (above) always reaches whatever is actually playing right now.

export type SpeechQueueItem = SpeechOptions & { text: string };

let speechQueue: SpeechQueueItem[] = [];
/** Invalidates in-flight speak calls. Stop and a new speak or queue each bump it. */
let playbackEpoch = 0;

function isCurrentSpeech(epoch: number): boolean {
  return epoch === playbackEpoch;
}

function beginSpeech(): number {
  playbackEpoch += 1;
  speechQueue = [];
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
  return speakPrepared(text, opts, beginSpeech());
}

async function speakPrepared(text: string, opts: SpeechOptions, epoch: number): Promise<boolean> {
  if (!isCurrentSpeech(epoch)) return false;
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
    const prepared = await rpc<{ ready: boolean; utterances: string[] }>(
      "voice/prepare",
      { text, voiceId: opts.voiceId, botId: opts.botId },
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
    let finished = false;
    try {
      for (const utterance of prepared.utterances) {
        if (session.isStopped || !isCurrentSpeech(epoch)) break;
        const audio = await renderUtterance(utterance, opts, requestContext);
        if (session.isStopped || !isCurrentSpeech(epoch)) break;
        await playMpeg(audio, session);
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
      await speakOneUtterance(Speech, utterance);
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

function speakOneUtterance(Speech: typeof ExpoSpeech, text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // No language or voice override: the platform default stays on device.
    // Forcing the UI locale mispronounces replies written in another language,
    // and Android's "network" voices upload the text.
    Speech.speak(text, {
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
    status: () => rpc("aiConsent/status", { uses: ["voice"] }, { requestContext }),
    prompt: promptAiConsent,
    allow: (input) => rpc("aiConsent/allow", input, { requestContext }),
    coalesceKey: aiConsentCoalesceKey(requestContext),
  });
  return renderUtterance(text, opts, requestContext);
}

async function renderUtterance(
  text: string,
  opts: SpeechOptions,
  requestContext: ApiRequestContext,
): Promise<Uint8Array> {
  const deadline = requestDeadline(VOICE_RESPONSE_TIMEOUT_MS);
  try {
    const res = await withAbort(
      fetch(`${requestContext.apiBase}/api/voice/speak`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "rakazo://",
          ...requestContext.headers,
        },
        body: JSON.stringify({ text, voiceId: opts.voiceId, botId: opts.botId }),
        signal: deadline.signal,
      }),
      deadline.signal,
    ).catch((error: unknown) => {
      throw deadline.signal.aborted
        ? error
        : new Error(errorText(error, t("Could not speak that.")));
    });
    if (!res.ok) {
      const body = await readVoiceError(res, deadline.signal);
      throw new Error(errorText(body.error ?? "", t("Could not speak that.")));
    }
    return await readResponseBytes(res, MAX_VOICE_AUDIO_BYTES, deadline.signal);
  } finally {
    deadline.dispose();
  }
}

// --- Hosted (MP3) playback: one HostedSession per speakText call, shared across
// its utterances, so Pause/Resume/Stop keep working across the gap between them.

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

export async function playMpeg(bytes: Uint8Array, session?: HostedSession): Promise<void> {
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
  const blob = new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" });
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
  const { createAudioPlayer, setAudioModeAsync } = await import("expo-audio");
  await setAudioModeAsync({
    playsInSilentMode: true,
    interruptionMode: "mixWithOthers",
    shouldPlayInBackground: false,
  });
  const file = new File(Paths.cache, `rakazo-voice-${Date.now()}.mp3`);
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

function requestDeadline(timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Voice request timed out.")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
    },
  };
}

async function readVoiceError(
  response: Response,
  signal: AbortSignal,
): Promise<{ error?: string }> {
  const bytes = await readResponseBytes(response, MAX_VOICE_ERROR_BYTES, signal);
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as { error?: string }) : {};
  } catch {
    return {};
  }
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    cancelResponse(response);
    throw new Error("Voice response is too large.");
  }
  return readBoundedResponseBytes(response, {
    maxBytes,
    tooLargeMessage: "Voice response is too large.",
    read: (operation) => withAbort(operation(), signal),
  });
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Voice request aborted."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Voice request aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function cancelResponse(response: Response): void {
  try {
    void Promise.resolve(response.body?.cancel()).catch(() => undefined);
  } catch {
    // Response cleanup is best-effort.
  }
}
