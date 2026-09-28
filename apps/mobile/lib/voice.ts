import { ensureAiDataConsent, readBoundedResponseBytes, toUtterances } from "@rakazo/core";
import { File, Paths } from "expo-file-system";
import type * as ExpoSpeech from "expo-speech";
import { promptAiConsent } from "./ai-consent";
import type { ApiRequestContext } from "./api";
import { captureApiRequestContext, rpc } from "./api";
import { loadDeviceVoiceEnabled } from "./device-voice";
import { t } from "./i18n";

type SpeechOptions = { voiceId?: string; botId?: string };
export const VOICE_RESPONSE_TIMEOUT_MS = 70_000;
export const MAX_VOICE_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_VOICE_ERROR_BYTES = 64 * 1024;

/** Bumped by every new reply and by stopSpeaking, so an old one drops its queued clips. */
let speechGeneration = 0;
/** Ends the clip playing right now, if any. */
let stopPlayback: (() => void) | null = null;

/** Cuts the reply off mid-sentence, for a caller who talked over it. */
export function stopSpeaking(): void {
  speechGeneration += 1;
  stopPlayback?.();
}

export async function speakText(text: string, opts: SpeechOptions = {}): Promise<boolean> {
  let useDeviceVoice = false;
  try {
    useDeviceVoice = await loadDeviceVoiceEnabled();
  } catch {
    // A read failure must not be treated as "off": that would send reply text
    // through hosted voice after the user opted for on-device only.
    useDeviceVoice = true;
  }
  if (useDeviceVoice) return speakWithDeviceVoice(text);
  const requestContext = await captureApiRequestContext();
  const prepared = await rpc<{ ready: boolean; utterances: string[] }>(
    "voice/prepare",
    { text, voiceId: opts.voiceId, botId: opts.botId },
    { requestContext },
  );
  if (!prepared.ready) return false;
  speechGeneration += 1;
  const mine = speechGeneration;
  for (const utterance of prepared.utterances) {
    if (speechGeneration !== mine) break;
    await playMpeg(await renderUtterance(utterance, opts, requestContext));
  }
  return true;
}

let deviceSpeechSession = 0;

function startDeviceSpeechSession(): number {
  return ++deviceSpeechSession;
}

function isCurrentDeviceSpeechSession(session: number): boolean {
  return session === deviceSpeechSession;
}

export async function speakWithDeviceVoice(text: string): Promise<boolean> {
  const utterances = toUtterances(text);
  if (utterances.length === 0) return false;
  // Claim the session before importing so a newer call cannot start during
  // that await and then overlap this call's remaining chunks.
  const session = startDeviceSpeechSession();
  const Speech = await loadExpoSpeech();
  if (!isCurrentDeviceSpeechSession(session)) return true;
  await Speech.stop();
  if (!isCurrentDeviceSpeechSession(session)) return true;
  for (const utterance of utterances) {
    if (!isCurrentDeviceSpeechSession(session)) return true;
    await speakOneUtterance(Speech, utterance);
  }
  return true;
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
    );
    if (!res.ok) {
      const body = await readVoiceError(res, deadline.signal);
      throw new Error(body.error ?? `Voice failed (${res.status})`);
    }
    return await readResponseBytes(res, MAX_VOICE_AUDIO_BYTES, deadline.signal);
  } finally {
    deadline.dispose();
  }
}

export async function playMpeg(bytes: Uint8Array): Promise<void> {
  const AudioCtor = (globalThis as { Audio?: typeof Audio }).Audio;
  if (typeof AudioCtor === "function") {
    await playWithHtmlAudio(AudioCtor, bytes);
    return;
  }
  await playWithNativeAudio(bytes);
}

async function playWithHtmlAudio(AudioCtor: typeof Audio, bytes: Uint8Array): Promise<void> {
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
        if (error) reject(error);
        else resolve();
      };
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error(t("Could not play that clip.")));
      stopPlayback = () => {
        audio.pause();
        finish();
      };
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
    stopPlayback = null;
    URL.revokeObjectURL(url);
  }
}

async function playWithNativeAudio(bytes: Uint8Array): Promise<void> {
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
      let timer = setTimeout(() => finish(new Error(t("Could not play that clip."))), 15_000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopPlayback = null;
        sub.remove();
        if (error) reject(error);
        else resolve();
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
        if (status.playing && status.duration > 0) {
          clearTimeout(timer);
          timer = setTimeout(
            () => finish(new Error(t("Could not play that clip."))),
            Math.min(120_000, Math.ceil(status.duration * 1000) + 8_000),
          );
        }
      });
      stopPlayback = () => {
        try {
          player.pause();
        } catch {
          // already stopped
        }
        finish();
      };
      try {
        player.play();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(t("Could not play that clip.")));
      }
    });
  } finally {
    stopPlayback = null;
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
