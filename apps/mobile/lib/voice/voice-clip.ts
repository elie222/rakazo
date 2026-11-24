import { t } from "@lingui/core/macro";
import {
  abortableDelay,
  MAX_TRANSCRIPTION_RESPONSE_BYTES,
  readJsonObjectWithin,
  recognitionLocaleTag,
} from "@rakazo/core";
import type { AudioRecorder } from "expo-audio";
import { File } from "expo-file-system";
import { Platform } from "react-native";
import type { ApiRequestContext } from "../api/api";
import { fetchServer } from "../api/server-headers";
import { errorText, voiceAccountErrorText } from "../api/user-error";
import { deviceLanguage, getActiveUiLocale } from "../i18n/i18n";
import { ensureVoiceConsent, setDictationAudio } from "./voice";

/** A recorded clip, ready to send to the voice provider. */
export type VoiceClip = { base64: string; mimeType: string };

/** A turn failure the caption already explains and the server logged if it answered: not a bug. */
export class ExpectedTurnFailure extends Error {}

// ponytail: naive fixed-threshold endpointing on the fallback path only. Swap for a VAD
// model if rooms with steady background noise start cutting people off mid-sentence.
const SPEECH_LEVEL_DB = -35;
const SILENCE_HANG_MS = 1_200;
const METER_POLL_MS = 200;
/** A dictation waveform redraws this often; slower reads look like a stutter. */
const LEVEL_POLL_MS = 80;
/** How long a starting recorder may go without a level (web reports one once it records). */
const METER_START_MS = 1_000;
const MAX_CLIP_MS = 30_000;
/** A dictated message stays well inside the server's transcription size limit. */
const MAX_DICTATION_MS = 5 * 60_000;

/**
 * Asks only when the microphone is not allowed yet: Android opens its prompt even for a granted
 * permission, and the app leaving for it ends a dictation already listening.
 */
export async function microphonePermission(signal: AbortSignal): Promise<{ granted: boolean }> {
  const { AudioModule } = await import("expo-audio");
  const current = await AudioModule.getRecordingPermissionsAsync();
  // A session that ended meanwhile must not open the prompt.
  if (current.granted || signal.aborted) return current;
  return AudioModule.requestRecordingPermissionsAsync();
}

// A dictation that finishes late must not switch recording off under the next one's recorder.
let recordingTurn: AbortSignal | undefined;

/**
 * Records one hands-free turn: wait for speech, stop once the speaker goes quiet. With `until`,
 * a pause never ends the clip; `until` aborting does, keeping what was recorded.
 */
export async function recordClip(
  signal: AbortSignal,
  until?: AbortSignal,
  options?: RecordOptions,
): Promise<VoiceClip | null> {
  const audio = await recordAudio(signal, until, options);
  if (!audio) return null;
  try {
    return { base64: await new File(audio.uri).base64(), mimeType: audio.mimeType };
  } finally {
    deleteQuietly(audio.uri);
  }
}

type RecordOptions = {
  /** Each metering read in dBFS, for a live waveform; undefined while the recorder has none. */
  onLevel?: (decibels: number | undefined) => void;
  /** The recorder started capturing, after any permission prompt and audio setup. */
  onRecording?: () => void;
  /** The clip never leaves the phone, so it keeps the recorder's full quality. */
  onDevice?: boolean;
};

/** Like `recordClip`, but leaves the recording on disk for the caller to read and delete. */
export async function recordAudio(
  signal: AbortSignal,
  until?: AbortSignal,
  { onLevel, onRecording, onDevice = false }: RecordOptions = {},
): Promise<{ uri: string; mimeType: string } | null> {
  const { AudioModule, RecordingPresets } = await import("expo-audio");
  if (signal.aborted) return null;
  const permission = await microphonePermission(signal);
  // The call can end while the microphone prompt is open.
  if (signal.aborted) return null;
  if (!permission.granted)
    throw new ExpectedTurnFailure(
      until ? t`Allow microphone access to dictate.` : t`Allow microphone access to call a bot.`,
    );
  let recorder: AudioRecorder | undefined;
  let heardSpeech = false;
  const maxMs = until ? MAX_DICTATION_MS : MAX_CLIP_MS;
  try {
    if (until) {
      recordingTurn = signal;
      await setDictationAudio(true);
    }
    const preset = RecordingPresets.HIGH_QUALITY;
    // The low-level constructor takes flat native options, unlike useAudioRecorder.
    const platformOptions =
      Platform.OS === "ios" ? preset.ios : Platform.OS === "android" ? preset.android : preset.web;
    const bitRate = 48_000;
    recorder = new AudioModule.AudioRecorder({
      ...preset,
      ...platformOptions,
      // A clip to upload stays small enough for a mobile connection; one the phone transcribes
      // keeps the recorder's quality, as T3 Code records it.
      ...(onDevice
        ? {}
        : {
            sampleRate: 16_000,
            numberOfChannels: 1,
            bitRate,
            ...(Platform.OS === "ios" ? { bitRateStrategy: "constant" } : {}),
            ...(Platform.OS === "web" ? { bitsPerSecond: bitRate } : {}),
          }),
      isMeteringEnabled: true,
    });
    await recorder.prepareToRecordAsync();
    // A dictation stopped before the microphone opened has nothing to send.
    if (signal.aborted || until?.aborted) return null;
    recorder.record();
    if (onRecording) {
      // iOS can decline to start, such as during an audio interruption, without throwing.
      if (!recorder.isRecording) throw new ExpectedTurnFailure(t`Could not start the microphone.`);
      onRecording();
    }
    let quietMs = 0;
    let metered = false;
    const pollMs = onLevel ? LEVEL_POLL_MS : METER_POLL_MS;
    for (
      let elapsed = 0;
      elapsed < maxMs && !signal.aborted && !until?.aborted;
      elapsed += pollMs
    ) {
      await abortableDelay(pollMs, signal);
      if (signal.aborted || until?.aborted) break;
      // A missing level is unknown, not 0 dB: a stand-in that loud hears speech in
      // silence and holds the clip to the cap. A recorder may still be starting; once it
      // has reported a level, or never does, nothing is left to endpoint on, so stop.
      // A dictated clip has `until` to end it, so it keeps recording.
      const level = recorder.getStatus().metering;
      onLevel?.(level);
      if (level === undefined) {
        if (until) continue;
        if (metered || elapsed + pollMs >= METER_START_MS) break;
        continue;
      }
      metered = true;
      if (level > SPEECH_LEVEL_DB) {
        heardSpeech = true;
        quietMs = 0;
      } else if (heardSpeech && !until) {
        quietMs += pollMs;
        if (quietMs >= SILENCE_HANG_MS) break;
      }
    }
    await recorder.stop();
    const uri = recorder.uri;
    // A dictated clip is kept even when it stayed under the speech level: soft speech is
    // still speech, and the provider returns nothing for silence.
    if (!uri || (!heardSpeech && !until) || signal.aborted) {
      deleteQuietly(uri);
      return null;
    }
    return {
      uri,
      mimeType: Platform.OS === "web" ? (preset.web.mimeType ?? "audio/webm") : "audio/m4a",
    };
  } finally {
    recorder?.release();
    if (recordingTurn === signal) {
      recordingTurn = undefined;
      await setDictationAudio(false);
    }
  }
}

export function deleteQuietly(uri: string | null): void {
  if (!uri) return;
  try {
    new File(uri).delete();
  } catch {
    // The clip is disposable; a leftover in the cache is fine.
  }
}

export async function transcribeClip(
  clip: VoiceClip,
  signal: AbortSignal,
  requestContext: ApiRequestContext,
  currentCallId?: string,
): Promise<string> {
  await ensureVoiceConsent(requestContext);
  const { apiBase, headers } = requestContext;
  // Without a language the provider guesses one, and a short clip can come back in another.
  const language = recognitionLocaleTag(getActiveUiLocale(), await deviceLanguage());
  const res = await fetchServer(
    `${apiBase}/api/voice/transcribe`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "rakazo://", ...headers },
      body: JSON.stringify({
        audioBase64: clip.base64,
        mimeType: clip.mimeType,
        language,
        callId: currentCallId,
      }),
      signal,
    },
    apiBase,
  );
  const body = await readJsonObjectWithin<{ text?: string; error?: string; code?: string }>(res, {
    maxBytes: MAX_TRANSCRIPTION_RESPONSE_BYTES,
    tooLargeMessage: t`Could not transcribe that.`,
    signal,
  });
  if (!res.ok) {
    throw new ExpectedTurnFailure(
      voiceAccountErrorText(body) ?? errorText(body.error ?? "", t`Could not transcribe that.`),
    );
  }
  return body.text ?? "";
}
