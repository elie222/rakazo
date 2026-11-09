/**
 * Server-side dictation: record a clip on the device and have the voice
 * provider transcribe it. This is the fallback when the device has no speech
 * recognition of its own — some Android ROMs ship without it, so on-device
 * dictation reports unavailable and the microphone silently does nothing.
 * It mirrors the call loop's fallback path (record a clip, POST it to
 * `/api/voice/transcribe`) without the call's shared audio-mode ownership,
 * so the composer and the voice chat screen can use it on their own.
 */

import { abortableDelay, readJsonObjectWithin } from "@rakazo/core";
import type { AudioRecorder } from "expo-audio";
import { File } from "expo-file-system";
import { captureApiRequestContext, rpc } from "./api";
import {
  MAX_CLIP_MS,
  METER_POLL_MS,
  METER_START_MS,
  SILENCE_HANG_MS,
  SPEECH_LEVEL_DB,
} from "./call-session";
import type { DictationGiveUp } from "./dictation";
import { t } from "./i18n";
import { fetchServer } from "./server-headers";
import { errorText, voiceAccountErrorText } from "./user-error";
import { probeProviderTranscribe } from "./voice-call-entry";

/** Matches the web client's cap on a transcription response. */
const MAX_TRANSCRIPTION_RESPONSE_BYTES = 64 * 1024;

type Session = {
  recorder: AudioRecorder;
  onFinal: (text: string) => void;
  onGiveUp?: (reason: DictationGiveUp) => void;
  controller: AbortController;
  /** `finish()` was called: end the clip at the next meter poll and transcribe it. */
  finishRequested: boolean;
  heardSpeech: boolean;
};

let active: Session | null = null;
/** The session that owns the recording audio mode; a newer session may not restore it. */
let audioOwner: Session | null = null;

type AudioModuleShape = typeof import("expo-audio");

let injectedAudio: AudioModuleShape | null = null;
/** Test seam: an injected audio module replaces the native one. */
export function setAudioModule(module: AudioModuleShape | null): void {
  injectedAudio = module;
}

async function loadAudio(): Promise<AudioModuleShape> {
  if (injectedAudio) return injectedAudio;
  return import("expo-audio");
}

/** True when the account's voice provider can transcribe a recorded clip. */
export async function serverTranscribeAvailable(): Promise<boolean> {
  return probeProviderTranscribe(() => rpc("voice/status"));
}

export function stopServerDictation(): void {
  const session = active;
  active = null;
  if (!session) return;
  session.controller.abort();
}

export function finishServerDictation(): void {
  const session = active;
  if (!session) return;
  session.finishRequested = true;
}

function deleteQuietly(uri: string | null): void {
  if (!uri) return;
  try {
    new File(uri).delete();
  } catch {
    // The clip is disposable; a leftover in the cache is fine.
  }
}

/**
 * Records one turn until a quiet gap ends it, then transcribes the clip.
 * Resolves once recording starts; the turn itself arrives through onFinal or
 * onGiveUp, like on-device dictation. No interim text: nothing is heard
 * until the server answers.
 */
export async function listenServerDictation(opts: {
  onFinal: (text: string) => void;
  onGiveUp?: (reason: DictationGiveUp) => void;
  signal?: AbortSignal;
}): Promise<void> {
  if (opts.signal?.aborted) return;
  stopServerDictation();
  const { AudioModule, RecordingPresets, setAudioModeAsync } = await loadAudio();
  if (opts.signal?.aborted) return;
  const permission = await AudioModule.requestRecordingPermissionsAsync();
  if (opts.signal?.aborted) return;
  if (!permission.granted) {
    opts.onGiveUp?.("failed");
    return;
  }
  const controller = new AbortController();
  const session: Session = {
    recorder: new AudioModule.AudioRecorder({
      ...RecordingPresets.HIGH_QUALITY,
      isMeteringEnabled: true,
    }),
    onFinal: opts.onFinal,
    onGiveUp: opts.onGiveUp,
    controller,
    finishRequested: false,
    heardSpeech: false,
  };
  active = session;
  opts.signal?.addEventListener(
    "abort",
    () => {
      if (active === session) stopServerDictation();
    },
    { once: true },
  );
  audioOwner = session;
  try {
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await session.recorder.prepareToRecordAsync();
    if (controller.signal.aborted || active !== session) return;
    session.recorder.record();
  } catch {
    if (active === session) {
      active = null;
      opts.onGiveUp?.("failed");
    }
    return;
  }
  // The metering loop runs on; `listen` resolves once recording started.
  void runClip(session).catch(() => undefined);
}

async function runClip(session: Session): Promise<void> {
  const { setAudioModeAsync } = await loadAudio();
  let clip: { base64: string; mimeType: string } | null = null;
  try {
    let quietMs = 0;
    let metered = false;
    for (
      let elapsed = 0;
      elapsed < MAX_CLIP_MS && !session.controller.signal.aborted && !session.finishRequested;
      elapsed += METER_POLL_MS
    ) {
      await abortableDelay(METER_POLL_MS, session.controller.signal);
      if (session.controller.signal.aborted || session.finishRequested) break;
      const level = session.recorder.getStatus().metering;
      if (level === undefined) {
        if (metered || elapsed + METER_POLL_MS >= METER_START_MS) break;
        continue;
      }
      metered = true;
      if (level > SPEECH_LEVEL_DB) {
        session.heardSpeech = true;
        quietMs = 0;
      } else if (session.heardSpeech) {
        quietMs += METER_POLL_MS;
        if (quietMs >= SILENCE_HANG_MS) break;
      }
    }
    if (active !== session) return;
    active = null;
    try {
      await session.recorder.stop();
    } catch {
      // A recorder that never started has nothing to stop.
    }
    const uri = session.recorder.uri;
    if (!uri || !session.heardSpeech || session.controller.signal.aborted) {
      deleteQuietly(uri);
      session.onGiveUp?.("idle");
      return;
    }
    const file = new File(uri);
    clip = { base64: await file.base64(), mimeType: "audio/m4a" };
    deleteQuietly(uri);
    const text = await transcribeClip(clip, session.controller.signal);
    if (active !== session && session.controller.signal.aborted) return;
    if (text.trim()) session.onFinal(text.trim());
    else session.onGiveUp?.("idle");
  } catch {
    if (active === session) active = null;
    else if (session.controller.signal.aborted) return;
    session.onGiveUp?.("failed");
  } finally {
    session.recorder.release();
    if (audioOwner === session) {
      audioOwner = null;
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(
        () => undefined,
      );
    }
  }
}

async function transcribeClip(
  clip: { base64: string; mimeType: string },
  signal: AbortSignal,
): Promise<string> {
  const { apiBase, headers } = await captureApiRequestContext();
  const res = await fetchServer(
    `${apiBase}/api/voice/transcribe`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "rakazo://", ...headers },
      body: JSON.stringify({ audioBase64: clip.base64, mimeType: clip.mimeType }),
      signal,
    },
    apiBase,
  );
  const body = await readJsonObjectWithin<{ text?: string; error?: string; code?: string }>(res, {
    maxBytes: MAX_TRANSCRIPTION_RESPONSE_BYTES,
    tooLargeMessage: t("Could not transcribe that."),
    signal,
  });
  if (!res.ok) {
    throw new Error(
      voiceAccountErrorText(body) ?? errorText(body.error ?? "", t("Could not transcribe that.")),
    );
  }
  return body.text ?? "";
}
