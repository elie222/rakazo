import {
  ACTIVE_RUN_STATUSES,
  abortableDelay,
  callClientNonce,
  isFarewell,
  latestSpokenCallReply,
  spokenMemory,
} from "@rakazo/core";
import type { AudioRecorder } from "expo-audio";
import { File } from "expo-file-system";
import { useSyncExternalStore } from "react";
import type { MobileSnapshot } from "./api";
import {
  applyMobileThreadEvent,
  blockText,
  captureApiRequestContext,
  rpc,
  subscribeThread,
} from "./api";
import * as dictation from "./dictation";
import { getActiveUiLocale, t } from "./i18n";
import { speakText, stopSpeaking } from "./voice";

export type CallPhase = "listening" | "thinking" | "speaking";
export type CallExchange = { role: "user" | "bot"; text: string };

export type CallState = {
  botId: string;
  botName: string;
  botColor: string;
  phase: CallPhase;
  muted: boolean;
  transcriptOpen: boolean;
  caption: string;
  heard: string;
  exchanges: CallExchange[];
};

export type CallClip = { base64: string; mimeType: string };

/** What one microphone session reports back: a running guess, then the finished turn. */
export type DictationHandlers = {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
};

/** Everything that touches the device or the server, so the loop stays testable. */
export type CallDeps = {
  /** On-device dictation for one turn. False when the device cannot recognise speech. */
  dictate: (handlers: DictationHandlers, signal: AbortSignal) => Promise<boolean>;
  /** Fallback when the device cannot: record a clip and send it to the voice provider. */
  record: (signal: AbortSignal) => Promise<CallClip | null>;
  transcribe: (clip: CallClip, signal: AbortSignal) => Promise<string>;
  /** Resolves with the run the message started, so only that run's reply is spoken. */
  send: (botId: string, text: string, clientNonce: string) => Promise<string | undefined>;
  /** Tells the server the caller hung up, so it files the call marker and the wrap-up run. */
  endCall: (botId: string, callId: string) => Promise<void>;
  speak: (botId: string, text: string) => Promise<void>;
  /** Cuts the reply off when the caller talks over it. */
  stopSpeaking: () => void;
  watch: (
    botId: string,
    onReply: (messageId: string, text: string, runId?: string) => void,
    onCallEnded: (ended: CallEnded) => void,
  ) => () => void;
};

/** What the bot's own `end_call` carries: the call it ends and the goodbye to speak. */
export type CallEnded = { callId?: string; farewell?: string };

/** How long a goodbye waits for a reply that may never come before hanging up anyway. */
const FAREWELL_TIMEOUT_MS = 20_000;
/** A call that cannot reach the microphone or the server this many turns in a row hangs up. */
const MAX_TURN_FAILURES = 3;

/** While audio plays, most of what the mic hears is the speaker: match on fewer words. */
const PLAYBACK_ECHO_RATIO = 0.4;
/** The only one-word turns worth cutting a reply short for. */
const INTERRUPT_WORDS = new Set(["stop", "wait", "hold on", "pause", "no"]);
/**
 * How long a phrase must stand mid-playback before it cuts the reply off. The silence
 * window that ends an utterance is far longer than a reply, so waiting for the finished
 * transcript lands the barge-in after the bot already stopped talking.
 */
export const INTERIM_BARGE_IN_MS = 300;
/** A dropped live feed is reconnected from the last seq it saw, backing off as it retries. */
const FEED_RETRY_MIN_MS = 250;
const FEED_RETRY_MAX_MS = 5_000;

// ponytail: naive fixed-threshold endpointing on the fallback path only. Swap for a VAD
// model if rooms with steady background noise start cutting people off mid-sentence.
const SPEECH_LEVEL_DB = -35;
const SILENCE_HANG_MS = 1_200;
const METER_POLL_MS = 200;
const MAX_CLIP_MS = 30_000;

let state: CallState | null = null;
/** Shared by every message this call sends, so the thread can group one call's exchange. */
let callId = "";
/** The run this call's last turn started: replies to anything else are not spoken. */
let callRunId: string | null = null;
let deps: CallDeps = productionDeps();
let turn: AbortController | null = null;
let unwatch: (() => void) | null = null;
let hangUpAfterReply = false;
/** The bot hung up itself: its farewell is the last thing this call speaks. */
let botEndedCall = false;
let hangUpTimer: ReturnType<typeof setTimeout> | null = null;
let spokenMessageId: string | null = null;
let failures = 0;
/** Whether the provider can transcribe, so the fallback path is worth trying at all. */
let canTranscribe = true;
/** Whether this device does its own speech recognition; unknown until the first turn. */
let onDevice: boolean | null = null;
/** A microphone session is running, so playback can leave it open instead of restarting it. */
let micOpen = false;
/** The caller cut the reply off: the speaker going idle must not reopen the microphone. */
let bargedIn = false;
/** Counting down a phrase heard over the reply, before it counts as cutting in. */
let interimTimer: ReturnType<typeof setTimeout> | null = null;
const watchers = new Set<() => void>();

export function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

export function getSnapshot(): CallState | null {
  return state;
}

export function useCallSession(): CallState | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function emit() {
  for (const watcher of [...watchers]) watcher();
}

function set(patch: Partial<CallState>) {
  if (!state) return;
  state = { ...state, ...patch };
  emit();
}

export function startCall(
  // `transcribe` says whether the voice provider can turn audio into text; a speak-only
  // provider is fine as long as the device recognises speech itself.
  call: { botId: string; botName: string; botColor?: string; transcribe?: boolean },
  overrides: Partial<CallDeps> = {},
): void {
  endCall();
  deps = { ...productionDeps(), ...overrides };
  callId = randomId();
  callRunId = null;
  canTranscribe = call.transcribe ?? true;
  onDevice = null;
  micOpen = false;
  bargedIn = false;
  spokenMemory.clear();
  state = {
    botId: call.botId,
    botName: call.botName,
    botColor: call.botColor ?? "",
    phase: "listening",
    muted: false,
    transcriptOpen: false,
    caption: "",
    heard: "",
    exchanges: [],
  };
  unwatch = deps.watch(call.botId, onReply, onCallEnded);
  emit();
  void listen();
}

export function endCall(): void {
  // The bot's own end_call already closed the call server-side; only a caller hang-up
  // has to say so. Fire and forget: the card is going away either way.
  if (state && !botEndedCall) void deps.endCall(state.botId, callId).catch(() => undefined);
  turn?.abort();
  turn = null;
  unwatch?.();
  unwatch = null;
  if (hangUpTimer) clearTimeout(hangUpTimer);
  hangUpTimer = null;
  hangUpAfterReply = false;
  botEndedCall = false;
  callRunId = null;
  spokenMessageId = null;
  failures = 0;
  micOpen = false;
  bargedIn = false;
  clearInterim();
  spokenMemory.clear();
  if (!state) return;
  state = null;
  emit();
}

export function toggleMute(): void {
  if (!state) return;
  const muted = !state.muted;
  set({ muted, heard: "" });
  if (muted) {
    turn?.abort();
    turn = null;
    micOpen = false;
    clearInterim();
    return;
  }
  if (state.phase === "listening") void listen();
}

export function toggleTranscript(): void {
  if (!state) return;
  set({ transcriptOpen: !state.transcriptOpen });
}

async function listen(): Promise<void> {
  if (!state) return;
  // The caller said goodbye: every path back to listening hangs up instead.
  if (hangUpAfterReply) {
    endCall();
    return;
  }
  set({ phase: "listening", heard: "", caption: "" });
  if (state.muted) return;
  await openMic();
}

/** Opens one microphone session, unless one is already running or the call is muted. */
async function openMic(): Promise<void> {
  if (!state || micOpen || state.muted) return;
  micOpen = true;
  const controller = new AbortController();
  turn = controller;
  const { botId } = state;
  const mine = () => !controller.signal.aborted && state?.botId === botId;
  try {
    if (onDevice !== false) {
      // The session stays open until it delivers a turn, so the microphone is still the
      // caller's while the reply plays and a barge-in can land.
      const started = await deps.dictate(
        {
          onInterim: (text) => {
            if (mine()) heardInterim(text);
          },
          onFinal: (text) => {
            if (mine()) void handleTranscript(text);
          },
        },
        controller.signal,
      );
      if (started) {
        onDevice = true;
        return;
      }
      onDevice = false;
    }
    // Muting or hanging up while the device was deciding: no microphone after all.
    if (!mine() || !state || state.muted) {
      micOpen = false;
      return;
    }
    if (!canTranscribe) {
      micOpen = false;
      set({
        caption: t(
          "Allow speech recognition in Settings, or connect ElevenLabs, OpenAI, or Fish Audio.",
        ),
      });
      return;
    }
    const clip = await deps.record(controller.signal);
    if (!mine()) return;
    const text = clip ? await deps.transcribe(clip, controller.signal) : "";
    if (!mine()) return;
    micOpen = false;
    await handleTranscript(text);
  } catch (error) {
    micOpen = false;
    if (!mine()) return;
    failTurn(error);
  }
}

/** One finished turn: drop the reply leaking back, cut in over playback, or send it. */
async function handleTranscript(raw: string): Promise<void> {
  if (!state) return;
  // The session stopped itself to deliver this.
  micOpen = false;
  failures = 0;
  const text = raw.trim();
  if (!text) {
    void listen();
    return;
  }
  if (state.phase === "speaking") {
    if (!isBargeIn(text)) {
      // The microphone caught the reply, not the caller: reopen so a real interruption
      // still lands, and let the reply play out.
      set({ heard: "" });
      void openMic();
      return;
    }
    // The caller talked over the reply: cut the audio, and never resume that message.
    bargedIn = true;
    clearInterim();
    deps.stopSpeaking();
    set({ phase: "thinking", caption: "" });
  }
  if (spokenMemory.isEcho(text)) {
    set({ heard: "" });
    void listen();
    return;
  }
  const { botId } = state;
  // The call this turn belongs to: hanging up and calling the same bot again before
  // send resolves must not hand the new call the old run.
  const turnCallId = callId;
  set({
    phase: "thinking",
    heard: text,
    exchanges: [...state.exchanges, { role: "user", text }],
  });
  if (isFarewell(text)) {
    hangUpAfterReply = true;
    hangUpTimer = setTimeout(endCall, FAREWELL_TIMEOUT_MS);
  }
  try {
    const runId = await deps.send(botId, text, callClientNonce(turnCallId));
    if (state?.botId === botId && callId === turnCallId) callRunId = runId ?? null;
  } catch (error) {
    if (state?.botId !== botId || callId !== turnCallId) return;
    failTurn(error);
  }
}

function failTurn(error: unknown): void {
  failures += 1;
  if (failures >= MAX_TURN_FAILURES) {
    endCall();
    return;
  }
  set({ phase: "listening", caption: errorText(error, t("Could not hear that.")) });
  void listen();
}

/**
 * A running guess: it shows what the caller is saying, and over a reply it is the only
 * signal that arrives while they are still talking. A phrase that stands for
 * INTERIM_BARGE_IN_MS stops the audio at once; the session keeps running, so its silence
 * window finishes the utterance and handleTranscript sends it as the next turn.
 */
function heardInterim(text: string): void {
  if (!state) return;
  if (state.phase !== "speaking") {
    clearInterim();
    set({ heard: text });
    return;
  }
  if (!isInterimBargeIn(text)) {
    clearInterim();
    return;
  }
  if (interimTimer) return;
  interimTimer = setTimeout(() => {
    interimTimer = null;
    if (state?.phase !== "speaking") return;
    bargedIn = true;
    deps.stopSpeaking();
    set({ phase: "listening", caption: "" });
  }, INTERIM_BARGE_IN_MS);
}

function clearInterim(): void {
  if (interimTimer) clearTimeout(interimTimer);
  interimTimer = null;
}

/**
 * True when a transcript heard during playback is the caller cutting in rather than the
 * reply leaking back into the mic: a real sentence, or a short interruption word.
 */
function isBargeIn(text: string): boolean {
  if (spokenMemory.isEcho(text, PLAYBACK_ECHO_RATIO)) return false;
  const cleaned = cleanWords(text);
  return cleaned.includes(" ") || INTERRUPT_WORDS.has(cleaned);
}

/** An interim is revised word by word, so a single stray word is never enough. */
function isInterimBargeIn(text: string): boolean {
  return cleanWords(text).includes(" ") && !spokenMemory.isEcho(text, PLAYBACK_ECHO_RATIO);
}

function cleanWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function onReply(messageId: string, text: string, runId?: string): void {
  // Work the bot files after hanging up belongs in the thread, not in the caller's ear.
  if (!state || botEndedCall || messageId === spokenMessageId) return;
  // A reply to something typed into the thread mid-call belongs on screen only.
  if (callRunId && runId && runId !== callRunId) return;
  spokenMessageId = messageId;
  speakAndListen(text);
}

function speakAndListen(text: string): void {
  if (!state) return;
  const { botId } = state;
  bargedIn = false;
  clearInterim();
  // Only the on-device path can hear the caller over the reply; the recorder would just
  // record the speaker, so it stays shut until playback ends.
  if (!onDevice) {
    turn?.abort();
    turn = null;
    micOpen = false;
  }
  set({ phase: "speaking", heard: "", exchanges: [...state.exchanges, { role: "bot", text }] });
  spokenMemory.remember(text);
  if (onDevice) void openMic();
  void deps
    .speak(botId, text)
    .catch((error: unknown) => {
      if (state?.botId === botId) set({ caption: errorText(error, t("Could not speak that.")) });
    })
    .finally(() => {
      if (state?.botId !== botId) return;
      // The caller cut in: the microphone is already theirs and their turn is on its way.
      if (bargedIn) return;
      void listen();
    });
}

/** The bot hung up: speak the goodbye it wrote, then end — the rest lands in the thread. */
function onCallEnded(ended: CallEnded): void {
  if (!state || ended.callId !== callId || botEndedCall) return;
  hangUpAfterReply = true;
  botEndedCall = true;
  if (hangUpTimer) clearTimeout(hangUpTimer);
  hangUpTimer = setTimeout(endCall, FAREWELL_TIMEOUT_MS);
  const farewell = ended.farewell?.trim();
  // Nothing to say: hang up instead of waiting out the fallback.
  if (!farewell) {
    endCall();
    return;
  }
  speakAndListen(farewell);
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function productionDeps(): CallDeps {
  return {
    dictate: dictateTurn,
    record: recordClip,
    transcribe: transcribeClip,
    send: sendHeard,
    endCall: closeCall,
    speak: speakReply,
    stopSpeaking,
    watch: watchReplies,
  };
}

/** The device's own speech recognition, which works with a speak-only voice provider. */
async function dictateTurn(handlers: DictationHandlers, signal: AbortSignal): Promise<boolean> {
  if (!(await dictation.available())) return false;
  await dictation.listen({ ...handlers, signal, lang: getActiveUiLocale() });
  return true;
}

/** Records one hands-free turn: wait for speech, stop once the speaker goes quiet. */
async function recordClip(signal: AbortSignal): Promise<CallClip | null> {
  const { AudioModule, RecordingPresets, setAudioModeAsync } = await import("expo-audio");
  const permission = await AudioModule.requestRecordingPermissionsAsync();
  if (!permission.granted) throw new Error(t("Allow microphone access to call a bot."));
  let recorder: AudioRecorder | undefined;
  let heardSpeech = false;
  try {
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    recorder = new AudioModule.AudioRecorder({
      ...RecordingPresets.HIGH_QUALITY,
      isMeteringEnabled: true,
    });
    await recorder.prepareToRecordAsync();
    recorder.record();
    let quietMs = 0;
    for (let elapsed = 0; elapsed < MAX_CLIP_MS && !signal.aborted; elapsed += METER_POLL_MS) {
      await abortableDelay(METER_POLL_MS, signal);
      if (signal.aborted) break;
      // Platforms without metering report nothing; keep recording to the cap.
      const level = recorder.getStatus().metering ?? 0;
      if (level > SPEECH_LEVEL_DB) {
        heardSpeech = true;
        quietMs = 0;
      } else if (heardSpeech) {
        quietMs += METER_POLL_MS;
        if (quietMs >= SILENCE_HANG_MS) break;
      }
    }
    await recorder.stop();
    const uri = recorder.uri;
    if (!uri || !heardSpeech || signal.aborted) {
      deleteQuietly(uri);
      return null;
    }
    const file = new File(uri);
    const base64 = await file.base64();
    deleteQuietly(uri);
    return { base64, mimeType: "audio/m4a" };
  } finally {
    recorder?.release();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
  }
}

function deleteQuietly(uri: string | null): void {
  if (!uri) return;
  try {
    new File(uri).delete();
  } catch {
    // The clip is disposable; a leftover in the cache is fine.
  }
}

async function transcribeClip(clip: CallClip, signal: AbortSignal): Promise<string> {
  const { apiBase, headers } = await captureApiRequestContext();
  const res = await fetch(`${apiBase}/api/voice/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "rakazo://", ...headers },
    body: JSON.stringify({ audioBase64: clip.base64, mimeType: clip.mimeType }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? t("Could not transcribe that."));
  return body.text ?? "";
}

async function sendHeard(
  botId: string,
  text: string,
  clientNonce: string,
): Promise<string | undefined> {
  const sent = await rpc<{ runId?: string }>("threads/send", { botId, clientNonce, text });
  return sent.runId;
}

async function closeCall(botId: string, id: string): Promise<void> {
  await rpc("threads/endCall", { botId, callId: id });
}

async function speakReply(botId: string, text: string): Promise<void> {
  if (!(await speakText(text, { botId }))) {
    throw new Error(t("Add a voice provider in Voice settings."));
  }
}

/** Live feed for the bot on the call, independent of whichever thread is on screen. */
function watchReplies(
  botId: string,
  onNewReply: (messageId: string, text: string, runId?: string) => void,
  onEnded: (ended: CallEnded) => void,
): () => void {
  const controller = new AbortController();
  const watchedCallId = callId;
  void (async () => {
    let snapshot: MobileSnapshot | null = null;
    let lastSeen: string | null = null;
    let cursor = 0;
    let retry = FEED_RETRY_MIN_MS;
    // The stream returns on an idle timeout as well as on a real failure, and a call
    // outlives both: pick it back up from the last seq until the caller hangs up. The
    // first snapshot is loaded in here too, so a failed load retries instead of
    // leaving the call with an open microphone and no feed.
    while (!controller.signal.aborted) {
      try {
        if (!snapshot) {
          snapshot = await rpc<MobileSnapshot>(
            "threads/get",
            { botId },
            { signal: controller.signal },
          );
          lastSeen = latestSpokenCallReply(snapshot.messages, watchedCallId)?.id ?? null;
          cursor = snapshot.cursor ?? 0;
        }
        await subscribeThread(
          { botId },
          cursor,
          (event) => {
            if (typeof event.seq === "number") cursor = event.seq;
            if (event.type === "thread.call.ended") {
              onEnded({
                callId: asText(event.payload?.callId),
                farewell: asText(event.payload?.farewell),
              });
              return;
            }
            snapshot = applyMobileThreadEvent(snapshot, event) ?? snapshot;
            if (!snapshot) return;
            const message = latestSpokenCallReply(snapshot.messages, watchedCallId);
            if (!message || message.id === lastSeen) return;
            // Wait for the message's own run to settle so half-written blocks are never
            // spoken; another run still working says nothing about this one.
            const run = snapshot?.run;
            const fromAnotherRun = Boolean(message.runId && message.runId !== run?.id);
            if (!fromAnotherRun && run && ACTIVE_RUN_STATUSES.some((s) => s === run.status)) return;
            const text = blockText(message).trim();
            if (!text) return;
            lastSeen = message.id;
            onNewReply(message.id, text, message.runId);
          },
          controller.signal,
        );
        retry = FEED_RETRY_MIN_MS;
      } catch {
        if (controller.signal.aborted) return;
        retry = Math.min(FEED_RETRY_MAX_MS, retry * 2);
      }
      if (controller.signal.aborted) return;
      await abortableDelay(retry, controller.signal);
    }
  })().catch(() => undefined);
  return () => controller.abort();
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function randomId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
