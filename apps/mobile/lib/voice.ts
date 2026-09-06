import { File, Paths } from "expo-file-system";
import {
  type ApiRequestContext,
  authHeaders,
  captureApiRequestContext,
  currentApiBase,
  rpc,
} from "./api";
import { t } from "./i18n";

type SpeechOptions = { voiceId?: string; botId?: string };
export const VOICE_RESPONSE_TIMEOUT_MS = 70_000;
export const MAX_VOICE_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_VOICE_ERROR_BYTES = 64 * 1024;

export async function speakText(text: string, opts: SpeechOptions = {}): Promise<boolean> {
  const requestContext = await captureApiRequestContext();
  const prepared = await rpc<{ ready: boolean; utterances: string[] }>(
    "voice/prepare",
    { text, voiceId: opts.voiceId, botId: opts.botId },
    { requestContext },
  );
  if (!prepared.ready) return false;
  for (const utterance of prepared.utterances) {
    await playMpeg(await speakUtterance(utterance, { ...opts, requestContext }));
  }
  return true;
}

export async function speakUtterance(
  text: string,
  opts: SpeechOptions & { requestContext?: ApiRequestContext } = {},
): Promise<Uint8Array> {
  const deadline = requestDeadline(VOICE_RESPONSE_TIMEOUT_MS);
  try {
    const res = await withAbort(
      fetch(`${opts.requestContext?.apiBase ?? currentApiBase()}/api/voice/speak`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "rakazo://",
          ...(opts.requestContext?.headers ?? (await authHeaders())),
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
  if (!response.body) {
    const buffer = await withAbort(response.arrayBuffer(), signal);
    if (buffer.byteLength > maxBytes) throw new Error("Voice response is too large.");
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Voice response is too large.");
      chunks.push(value);
    }
  } catch (error) {
    cancelReader(reader);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already cancelled or released
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  } catch {
    // Response cleanup is best-effort.
  }
}
