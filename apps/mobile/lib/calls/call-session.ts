import { ph, t } from "@lingui/core/macro";
import type { BotAvatarSet } from "@rakazo/contracts";
import type { CallExchange } from "@rakazo/core";
import {
  AiConsentBlocked,
  abortableDelay,
  CALL_FAREWELL_TIMEOUT_MS,
  callClientNonce,
  callRunStatus,
  callTurn,
  createCallReplySpeech,
  createCallSendTracker,
  createInterimBargeIn,
  isCallBargeIn,
  isFarewell,
  isRunWorking,
  newClientId,
  pendingCallSecretAsk,
  spokenMemory,
  WAITING_ON_USER_RUN_STATUSES,
  withBotSpeech,
} from "@rakazo/core";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import type { ApiRequestContext } from "../api/api";
import { configureSessionEndHangUp } from "../api/api-server";
import type { MobileSnapshot } from "../api/mobile-types";
import { currentSessionGeneration, subscribeSessionGeneration } from "../api/session";
import { errorText } from "../api/user-error";
import { hapticImpact, hapticSuccess } from "../native/haptics";
import { reportMobileError } from "../platform/monitoring";
import type { DictationGiveUp } from "../voice/dictation";
import type { VoiceClip } from "../voice/voice-clip";
import { ExpectedTurnFailure } from "../voice/voice-clip";
import { MAX_TURN_FAILURES, productionDeps } from "./call-deps";
import type { CallCue } from "./call-sounds";

export type CallPhase = "listening" | "thinking" | "speaking";

export type CallState = {
  botId: string;
  botName: string;
  botColor: string;
  botAvatarSet?: BotAvatarSet;
  phase: CallPhase;
  muted: boolean;
  transcriptOpen: boolean;
  caption: string;
  heard: string;
  exchanges: CallExchange[];
};

/** What one microphone session reports back: a running guess, then the finished turn. */
export type DictationHandlers = {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onGiveUp: (reason: DictationGiveUp) => void;
};

/** Everything that touches the device or the server, so the loop stays testable. */
export type CallDeps = {
  /** On-device dictation for one turn. False when the device cannot recognise speech. */
  dictate: (handlers: DictationHandlers, signal: AbortSignal) => Promise<boolean>;
  /**
   * Fallback when the device cannot: record a clip and send it to the voice provider. Asks for
   * voice data sharing first, so it can throw AiConsentBlocked before the microphone opens.
   */
  record: (signal: AbortSignal) => Promise<VoiceClip | null>;
  transcribe: (clip: VoiceClip, signal: AbortSignal) => Promise<string>;
  /** Resolves with the run the message started, so only that run's reply is spoken. */
  send: (botId: string, text: string, clientNonce: string) => Promise<string | undefined>;
  /** Answers the open question the bot's waiting run asked. */
  answer: (
    botId: string,
    ask: { runId: string; messageId: string; answer: string },
    clientNonce: string,
  ) => Promise<void>;
  /** Steers the run that is still working. */
  followUp: (botId: string, text: string, clientNonce: string) => Promise<void>;
  /** Tells the server the caller hung up, so it files the call marker and the wrap-up run. */
  endCall: (botId: string, callId: string) => Promise<void>;
  /**
   * Says `text`, cutting off whatever the call is saying, or with `queue` after it, so a reply
   * can be said sentence by sentence as the bot writes it.
   */
  speak: (botId: string, text: string, queue?: boolean) => Promise<void>;
  /** Cuts the reply off when the caller talks over it. */
  stopSpeaking: () => void;
  /** The opening cue as the call starts, the closing one once the caller's turn is heard. */
  cue: (cue: CallCue) => Promise<void>;
  audio: (active: boolean) => Promise<void>;
  /** The soft sound while the bot works on a turn: loaded at call start, freed at hang-up. */
  waitSound: (action: "preload" | "start" | "stop" | "release") => void;
  watch: (
    botId: string,
    onReply: (messageId: string, text: string, runId?: string) => void,
    onCallEnded: (ended: CallEnded) => void,
    /** Every update of the call's thread, so a turn can answer what the bot is waiting on. */
    onThread: (thread: MobileSnapshot) => void,
  ) => () => void;
};

/** The bot a caller asked to be put through to, and how to ring it once this call hangs up. */
export type CallSwitch = { name: string; ring: () => void };

/** What the bot's own `end_call` carries: the call it ends and the goodbye to speak. */
export type CallEnded = { callId?: string; farewell?: string };

let state: CallState | null = null;
/** The session the call started in: a sign-out or an account or server change ends the call. */
let callSessionGeneration = 0;
/** Shared by every message this call sends, so the thread can group one call's exchange. */
let callId = "";
/** Requests for this call that must persist before its server-side hang-up. */
const callSends = createCallSendTracker();
/** Hang-ups this session still owes its server; a sign-out waits briefly for them to land. */
const hangUps = new Set<Promise<void>>();
/** The run this call's last turn started: replies to anything else are not spoken. */
let callRunId: string | null = null;
let deps: CallDeps = ownDeps();
let turn: AbortController | null = null;
let unwatch: (() => void) | null = null;
let hangUpAfterReply = false;
/** Caller farewell send already resolved; speech consent refuse can finish the hang-up. */
let farewellSent = false;
/** Disclosure was refused: do not start speech again until the caller unmutes. */
let consentBlocked = false;
/** The bot hung up itself: its farewell is the last thing this call speaks. */
let botEndedCall = false;
let hangUpTimer: ReturnType<typeof setTimeout> | null = null;
let spokenMessageId: string | null = null;
/** The reply's sentences already said while its run was still writing it. */
const replySpeech = createCallReplySpeech();
/** The run whose reply this turn says as it is written; null once that reply is whole. */
let streamRunId: string | null = null;
/** The call's thread as the live feed last reported it. */
let thread: MobileSnapshot | null = null;
/** The microphone stays shut while the bot waits on a code typed on screen. */
let heldForCode = false;
let failures = 0;
/** Counts the caller's turns, so a closing cue that ends late starts no waiting sound for a newer turn. */
let turnSeq = 0;
/** Counts the bot's speeches, so one that settles late cannot act over a newer one. */
let speechSeq = 0;
/** Whether the provider can transcribe, so the fallback path is worth trying at all. */
let canTranscribe = true;
/** Whether this device does its own speech recognition; unknown until a turn tries it again. */
let onDevice: boolean | null = null;
let recognitionFailures = 0;
/** A microphone session is running, so playback can leave it open instead of restarting it. */
let micOpen = false;
/** True from ringing until the start cue ends: nothing may open the microphone before the greeting. */
let opening = false;
/** The caller cut the reply off: the speaker going idle must not reopen the microphone. */
let bargedIn = false;
let guardTimer: ReturnType<typeof setTimeout> | null = null;
/** Counting down a phrase heard over the reply, before it counts as cutting in. */
const interim = createInterimBargeIn(() => {
  if (state?.phase !== "speaking") return;
  bargedIn = true;
  deps.stopSpeaking();
  sealStream();
  set({ phase: "listening", caption: "" });
});
/** Takes over a turn that asks for another bot: the bot to hand over to, or nothing. */
let switchBot: ((text: string) => CallSwitch | undefined) | undefined;
let switching = false;
const watchers = new Set<() => void>();

subscribeSessionGeneration(() => {
  if (state && currentSessionGeneration() !== callSessionGeneration) endCall();
});

export function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

export function getSnapshot(): CallState | null {
  return state;
}

function getCallActiveSnapshot(): boolean {
  return state !== null;
}

export function useCallActive(): boolean {
  return useSyncExternalStore(subscribe, getCallActiveSnapshot, getCallActiveSnapshot);
}

export function useCallSession(): CallState | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function emit() {
  for (const watcher of [...watchers]) watcher();
}

function set(patch: Partial<CallState>) {
  if (!state) return;
  // The waiting sound belongs to "thinking" only: a reply, a retry, or a cut-in ends it.
  if (patch.phase && patch.phase !== "thinking" && state.phase === "thinking") {
    deps.waitSound("stop");
  }
  state = { ...state, ...patch };
  emit();
}

export function startCall(
  // `transcribe` says whether the voice provider can turn audio into text; a speak-only
  // provider is fine as long as the device recognises speech itself.
  call: {
    botId: string;
    botName: string;
    botColor?: string;
    botAvatarSet?: BotAvatarSet;
    transcribe?: boolean;
    /** Spoken as the call connects, before the caller's first turn. */
    greeting?: string;
    answered?: { callId: string };
    requestContext?: ApiRequestContext;
    /** Called with each finished turn; a target means the caller asked for that bot instead. */
    switchBot?: (text: string) => CallSwitch | undefined;
    /** The session the caller's setup began in; no call starts once it has changed. */
    session?: number;
  },
  overrides: Partial<CallDeps> = {},
): string | undefined {
  if (call.session !== undefined && call.session !== currentSessionGeneration()) return undefined;
  endCall();
  callSessionGeneration = currentSessionGeneration();
  callId = call.answered?.callId ?? newClientId();
  deps = { ...ownDeps(call.requestContext), ...overrides };
  switchBot = call.switchBot;
  callRunId = null;
  canTranscribe = call.transcribe ?? true;
  onDevice = null;
  recognitionFailures = 0;
  micOpen = false;
  bargedIn = false;
  spokenMemory.clear();
  replySpeech.clear();
  streamRunId = null;
  state = {
    botId: call.botId,
    botName: call.botName,
    botColor: call.botColor ?? "",
    botAvatarSet: call.botAvatarSet,
    phase: "listening",
    muted: false,
    transcriptOpen: false,
    caption: "",
    heard: "",
    exchanges: [],
  };
  // An ended call's watcher can still deliver a buffered snapshot; it must not reach this call.
  const watchedCallId = callId;
  unwatch = deps.watch(call.botId, onReply, onCallEnded, (next) => {
    if (callId === watchedCallId) onThread(next);
  });
  emit();
  void openCall(callId, call.greeting);
  return callId;
}

/** The opening cue, then the greeting, then the caller's first turn. */
async function openCall(openedCallId: string, greeting?: string): Promise<void> {
  deps.waitSound("preload");
  opening = true;
  await deps.audio(true).catch((error: unknown) => {
    reportMobileError(error, "voice.microphone", { source: "call-audio" });
  });
  if (!state || callId !== openedCallId) return;
  await deps.cue("start").catch(() => undefined);
  if (!state || callId !== openedCallId || botEndedCall) return;
  hapticSuccess();
  opening = false;
  if (greeting) speakAndListen(greeting);
  else void listen();
}

/** A background voice/status result can enable provider fallback after the call has started. */
export function setCallProviderTranscribe(enabled: boolean, forCallId?: string): void {
  if (!state || (forCallId !== undefined && forCallId !== callId)) return;
  canTranscribe = enabled;
  // Dictation can fail before the probe returns, which leaves the mic closed.
  if (enabled && !opening && state.phase === "listening" && !micOpen && !state.muted) void listen();
}

/** The app's Hang up action; shared or system-driven cleanup stays silent. */
export function hangUp(): void {
  if (!state) return;
  hapticImpact();
  endCall();
}

export function endCall(): void {
  // The bot's own end_call already closed the call server-side; only a caller hang-up
  // has to say so. Fire and forget: the card is going away either way.
  if (state && !botEndedCall) {
    const { botId } = state;
    const closingCallId = callId;
    const closeServerCall = deps.endCall;
    const closed = callSends.closeAfterSends(closingCallId, () =>
      closeServerCall(botId, closingCallId),
    );
    hangUps.add(closed);
    void closed.then(() => hangUps.delete(closed));
  }
  if (state) {
    deps.waitSound("release");
    // A reply can still be playing when the caller hangs up: cut it with the call.
    deps.stopSpeaking();
  }
  turn?.abort();
  turn = null;
  if (state) void deps.audio(false).catch(() => undefined);
  unwatch?.();
  unwatch = null;
  clearEchoGuard();
  if (hangUpTimer) clearTimeout(hangUpTimer);
  hangUpTimer = null;
  hangUpAfterReply = false;
  farewellSent = false;
  consentBlocked = false;
  botEndedCall = false;
  callRunId = null;
  spokenMessageId = null;
  replySpeech.clear();
  streamRunId = null;
  thread = null;
  heldForCode = false;
  failures = 0;
  micOpen = false;
  opening = false;
  bargedIn = false;
  switchBot = undefined;
  switching = false;
  interim.clear();
  spokenMemory.clear();
  if (!state) return;
  state = null;
  emit();
}

/** Quiet gap between playback ending and opening an uncancelled microphone (speaker/reverb tail). */
export const ECHO_GUARD_MS = 600;
/** How long a sign-out or server switch waits for the hang-up before it continues anyway. */
export const SIGN_OUT_HANG_UP_MS = 3_000;

function clearEchoGuard(): void {
  if (!guardTimer) return;
  clearTimeout(guardTimer);
  guardTimer = null;
}

function guardThenListen(): void {
  clearEchoGuard();
  guardTimer = setTimeout(() => {
    guardTimer = null;
    void listen();
  }, ECHO_GUARD_MS);
}

/**
 * iOS pairs SpeechRecognizer with AVAudioSession voice-chat AEC. Android SpeechRecognizer
 * reads VOICE_RECOGNITION without AEC against loudspeaker playback, so the mic stays shut
 * while the bot speaks and waits out the speaker/reverb tail before reopening.
 */
function supportsPlaybackBargeIn(): boolean {
  return Boolean(onDevice) && Platform.OS !== "android";
}

/**
 * Hangs up while the session still exists, waiting at most `SIGN_OUT_HANG_UP_MS` for pending
 * sends and the hang-up. What follows — a sign-out or a server switch — discards the session,
 * so a hang-up still queued after that is dropped: by then its request may carry no one's or
 * another user's token.
 */
export async function endCallBeforeSessionEnd(): Promise<void> {
  endCall();
  const landed = new AbortController();
  void Promise.all(hangUps).then(() => landed.abort());
  await abortableDelay(SIGN_OUT_HANG_UP_MS, landed.signal);
}

// A server switch discards the old server's session; the call hangs up on it first.
configureSessionEndHangUp(endCallBeforeSessionEnd);

export function toggleMute(): void {
  if (!state) return;
  const muted = !state.muted;
  set({ muted, heard: "" });
  if (muted) {
    turn?.abort();
    turn = null;
    micOpen = false;
    interim.clear();
    return;
  }
  consentBlocked = false;
  if (state.phase === "listening" && !opening) void listen();
}

export function toggleTranscript(): void {
  if (!state) return;
  set({ transcriptOpen: !state.transcriptOpen });
}

async function listen(): Promise<void> {
  if (!state) return;
  clearEchoGuard();
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
  // A code is typed on screen: the call must not hear or transcribe it. Until the thread's
  // first snapshot arrives, the call cannot tell, so it waits for that too.
  if (!thread || pendingCallSecretAsk(thread)) {
    heldForCode = true;
    if (thread) set({ caption: t`Hang up, then enter the code on screen.` });
    return;
  }
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
            if (!mine()) return;
            recognitionFailures = 0;
            void handleTranscript(text);
          },
          onGiveUp: (reason) => {
            if (!mine()) return;
            controller.abort();
            micOpen = false;
            interim.clear();
            set({ heard: "" });
            if (reason === "failed") {
              onDevice = false;
              recognitionFailures += 1;
            }
            // Recording must wait for playback; recognition can still hear a barge-in with AEC.
            if (state?.phase !== "speaking" || supportsPlaybackBargeIn()) void openMic();
          },
        },
        controller.signal,
      );
      if (!mine()) return;
      if (started) {
        onDevice = true;
        return;
      }
      onDevice = false;
      recognitionFailures = 0;
    }
    // Muting or hanging up while the device was deciding: no microphone after all.
    if (!mine() || !state || state.muted) {
      micOpen = false;
      return;
    }
    if (!canTranscribe) {
      micOpen = false;
      set({
        caption: t`Allow speech recognition in Settings, or connect a voice provider that transcribes.`,
      });
      return;
    }
    const clip = await deps.record(controller.signal);
    if (!mine()) return;
    const text = clip ? await deps.transcribe(clip, controller.signal) : "";
    if (!mine()) return;
    micOpen = false;
    if (recognitionFailures === 1) onDevice = null;
    await handleTranscript(text);
  } catch (error) {
    if (!mine()) return;
    micOpen = false;
    if (error instanceof AiConsentBlocked) blockForConsent(error);
    else failTurn(error);
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
    // Between sentences of a reply still being written the turn stays the bot's.
    if (replyStillWritten()) void openMic();
    else void listen();
    return;
  }
  // Between sentences of a reply still being written counts as over it: a backchannel or the
  // reply's echo must not become a turn.
  if (state.phase === "speaking" || replyStillWritten()) {
    if (!supportsPlaybackBargeIn()) {
      set({ heard: "" });
      return;
    }
    if (!isCallBargeIn(text)) {
      // The microphone caught the reply, not the caller: reopen so a real interruption
      // still lands, and let the reply play out.
      set({ heard: "" });
      void openMic();
      return;
    }
    // The caller talked over the reply: cut the audio, and never resume that message.
    bargedIn = true;
    interim.clear();
    deps.stopSpeaking();
    sealStream();
    set({ phase: "thinking", caption: "" });
  }
  if (spokenMemory.isEcho(text)) {
    set({ heard: "" });
    void listen();
    return;
  }
  // The caller's turn: a reply said as it was written ended with it.
  streamRunId = null;
  const handOver = switchBot?.(text);
  if (handOver) {
    void switchCall(handOver, text);
    return;
  }
  const next = callTurn(thread, text);
  if (next.kind === "enter_code") {
    heldForCode = true;
    set({ phase: "listening", heard: "", caption: t`Hang up, then enter the code on screen.` });
    return;
  }
  const closing = isFarewell(text);
  // An approval is only granted on screen, next to its details; a spoken reply would be refused.
  if (next.kind === "approve_on_screen") {
    // Its card was already on screen; only what its run says after the tap is spoken.
    spokenMessageId = next.messageId;
    // A new turn: an earlier request still in flight must not replace the run it expects.
    ++turnSeq;
    callRunId = next.runId;
    if (closing) hangUpAfterReply = true;
    void listen();
    set({ caption: t`Approve or deny it on screen.` });
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
  // The waiting sound follows the closing cue, and only if the bot has not answered yet.
  const cueTurn = ++turnSeq;
  void deps
    .cue("end")
    .catch(() => undefined)
    .then(() => {
      if (state?.phase !== "thinking" || callId !== turnCallId || turnSeq !== cueTurn) return;
      deps.waitSound("start");
    });
  if (closing) {
    hangUpAfterReply = true;
    // A second goodbye replaces this timer. Clear the previous one or it can
    // end the next call after this one has already hung up.
    if (hangUpTimer) clearTimeout(hangUpTimer);
    hangUpTimer = setTimeout(endCall, CALL_FAREWELL_TIMEOUT_MS);
  }
  let releasePendingSend: (() => void) | undefined;
  // A reply can reach the feed before the request returns, so set the expected run first: an
  // answer resumes the question's run, and a follow-up may be answered by a continuation run,
  // so any reply in the call counts. A failed request restores the previous expectation.
  const previousCallRunId = callRunId;
  if (next.kind === "answer") callRunId = next.runId;
  else if (next.kind === "follow_up") callRunId = null;
  try {
    const clientNonce = callClientNonce(turnCallId);
    const sendRequest =
      next.kind === "answer"
        ? deps
            .answer(
              botId,
              { runId: next.runId, messageId: next.messageId, answer: next.answer },
              clientNonce,
            )
            .then(() => next.runId)
        : next.kind === "follow_up"
          ? deps.followUp(botId, text, clientNonce).then(() => undefined)
          : deps.send(botId, text, clientNonce);
    releasePendingSend = callSends.track(turnCallId, sendRequest);
    const runId = await sendRequest;
    if (state?.botId === botId && callId === turnCallId) {
      // A later turn already set what it expects; this older request must not undo it.
      if (turnSeq === cueTurn) callRunId = runId ?? null;
      if (hangUpAfterReply) farewellSent = true;
    }
  } catch (error) {
    if (state?.botId !== botId || callId !== turnCallId) return;
    if ((next.kind === "answer" || next.kind === "follow_up") && turnSeq === cueTurn)
      callRunId = previousCallRunId;
    if (error instanceof AiConsentBlocked) {
      // Bot already closed server-side: do not clear its hang-up into a muted stuck call.
      if (botEndedCall) {
        endCall();
        return;
      }
      // Goodbye was not delivered; drop the armed hang-up so mute/retry can continue.
      if (hangUpTimer) clearTimeout(hangUpTimer);
      hangUpTimer = null;
      hangUpAfterReply = false;
      farewellSent = false;
      blockForConsent(error);
      return;
    }
    // A newer turn already owns the call's state; an older request's failure must not reset it.
    if (turnSeq !== cueTurn) return;
    failTurn(error);
  } finally {
    releasePendingSend?.();
  }
}

function failTurn(error: unknown): void {
  if (!(error instanceof ExpectedTurnFailure)) reportMobileError(error, "voice.turn");
  // A reply delivered by the live feed already owns playback and microphone recovery.
  if (state?.phase === "speaking") return;
  failures += 1;
  if (failures >= MAX_TURN_FAILURES) {
    endCall();
    return;
  }
  set({ phase: "listening", caption: errorText(error, t`Could not hear that.`) });
  void listen();
}

/** A denied disclosure is not a transient call failure: wait for an explicit retry. */
function blockForConsent(error: AiConsentBlocked): void {
  consentBlocked = true;
  clearEchoGuard();
  turn?.abort();
  turn = null;
  micOpen = false;
  interim.clear();
  set({
    phase: "listening",
    muted: true,
    heard: "",
    caption: errorText(error, t`Could not hear that.`),
  });
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
    interim.clear();
    set({ heard: text });
    return;
  }
  if (!supportsPlaybackBargeIn()) return;
  interim.hear(text);
}

function onReply(messageId: string, text: string, runId?: string): void {
  // Work the bot files after hanging up belongs in the thread, not in the caller's ear.
  if (!state || switching || botEndedCall || messageId === spokenMessageId) return;
  // A reply to something typed into the thread mid-call belongs on screen only.
  if (callRunId && runId && runId !== callRunId) return;
  spokenMessageId = messageId;
  // What was already said while the run wrote it is not said again; the rest follows it.
  const streamed = Boolean(runId && runId === streamRunId);
  if (streamed) streamRunId = null;
  const rest = runId ? replySpeech.finish(runId, text, messageId) : text;
  if (rest) speakAndListen(rest, { queue: streamed, continues: streamed });
  // Nothing left to say: the turn ends now, or once the sentences still playing end.
  else if (state.phase !== "speaking") endTurn();
}

/**
 * Says each finished sentence of the reply while its run is still writing it, when the server
 * marks that text as the reply. Without the mark, the reply is said once it is whole.
 */
function speakAsWritten(): void {
  const runId = callRunId;
  if (!state || !thread || !runId || switching || botEndedCall || consentBlocked || opening) return;
  const status = callRunStatus(thread, runId);
  // A run that stops to ask the caller ends this reply. The call does not say the question, so
  // nothing finishes it: forget it, and say what the run writes once it resumes from the start.
  if (WAITING_ON_USER_RUN_STATUSES.some((waiting) => waiting === status)) replySpeech.clear();
  if (!isRunWorking(status)) return;
  const sentences = replySpeech.take(thread.messages, runId);
  if (!sentences) return;
  const continues = streamRunId === runId;
  streamRunId = runId;
  speakAndListen(sentences, { queue: true, continues });
}

/** The caller cut in: nothing more of the reply being written is said until it is whole. */
function sealStream(): void {
  if (streamRunId) replySpeech.seal(thread?.messages ?? [], streamRunId);
  streamRunId = null;
}

/** A reply is being said as it is written, and its run is still writing it. */
function replyStillWritten(): boolean {
  return streamRunId !== null && isRunWorking(callRunStatus(thread, streamRunId));
}

/** Keeps the thread current, and the microphone shut while the bot waits on a typed code. */
function onThread(next: MobileSnapshot): void {
  thread = next;
  if (!state) return;
  if (pendingCallSecretAsk(next)) {
    // Also when the mic never opened (the thread loaded late): the caller still needs to know.
    if (heldForCode) set({ caption: t`Hang up, then enter the code on screen.` });
    if (!micOpen) return;
    heldForCode = true;
    turn?.abort();
    turn = null;
    micOpen = false;
    interim.clear();
    set({ heard: "", caption: t`Hang up, then enter the code on screen.` });
    return;
  }
  // The first snapshot arrived, or the code was entered on screen: listen again unless the
  // bot is about to speak.
  if (heldForCode) {
    heldForCode = false;
    if (state.phase === "listening" && !micOpen && !opening) void listen();
  }
  speakAsWritten();
}

/** The bot on the line says it is handing over, then this call hangs up and the other bot rings. */
async function switchCall(target: CallSwitch, heard: string): Promise<void> {
  if (!state || switching) return;
  switching = true;
  clearEchoGuard();
  const { botId } = state;
  const switchingCallId = callId;
  const notice = t`OK, switching to ${ph({ name: target.name })}.`;
  turn?.abort();
  turn = null;
  micOpen = false;
  set({
    phase: "speaking",
    heard: "",
    exchanges: [...state.exchanges, { role: "user", text: heard }, { role: "bot", text: notice }],
  });
  // The caller can hang up during either await: then nothing more is said and nobody rings.
  const stillOn = () => state !== null && callId === switchingCallId;
  await deps.cue("end").catch(() => undefined);
  if (!stillOn()) return;
  try {
    await deps.speak(botId, notice);
  } catch (error) {
    if (!stillOn()) return;
    // A refused voice disclosure stays refused: mute here rather than ring a bot that would ask again.
    if (error instanceof AiConsentBlocked) {
      switching = false;
      blockForConsent(error);
      return;
    }
  }
  if (!stillOn()) return;
  endCall();
  target.ring();
}

/**
 * Says `text`, then hands the turn back to the caller. With `queue` it follows what is still
 * playing, and `continues` adds it to the line the bot is still saying; the turn passes only
 * once the newest speech has played and the run is no longer writing the reply.
 */
function speakAndListen(text: string, { queue = false, continues = false } = {}): void {
  if (!state) return;
  clearEchoGuard();
  const { botId } = state;
  const speakingCallId = callId;
  // Sentences of a reply said as it is written, as opposed to its rest or a goodbye.
  const writtenRunId = queue ? streamRunId : null;
  // Bump before anything else: this attempt supersedes all older ones, even if it then
  // declines to speak, so only the newest speech below may run its handlers.
  const speechId = ++speechSeq;
  // An older speech can settle long after a newer one started, because its barge-in
  // stop need not resolve it: it must not act on the newer speech's call.
  const superseded = () =>
    state?.botId !== botId || callId !== speakingCallId || speechSeq !== speechId;
  let blockedByConsent = false;
  // More of the same reply keeps a cut-in that is already counting down.
  if (!continues) {
    bargedIn = false;
    interim.clear();
  }
  set({ exchanges: withBotSpeech(state.exchanges, text, continues) });
  // A prior disclosure refuse stays muted until unmute; do not re-open speech consent.
  if (consentBlocked) {
    set({ phase: "listening", heard: "" });
    return;
  }
  spokenMemory.remember(text);
  // Only on-device recognition with hardware AEC can hear the caller over the reply;
  // without it (recording fallback, or Android SpeechRecognizer), keep the mic shut until playback ends.
  const bargeIn = supportsPlaybackBargeIn();
  if (!bargeIn) {
    turn?.abort();
    turn = null;
    micOpen = false;
  }
  set({ phase: "speaking", heard: "" });
  if (bargeIn) void openMic();
  void deps
    .speak(botId, text, queue)
    .catch((error: unknown) => {
      // A failed clip may have gone unheard: the finished reply is said whole instead. Later
      // sentences of the same speech fail with it, so this holds even when one superseded it.
      if (writtenRunId) replySpeech.forget(writtenRunId);
      if (superseded()) return;
      if (error instanceof AiConsentBlocked) {
        blockedByConsent = true;
        // Hang-up already committed server-side or via a sent goodbye.
        if (botEndedCall || farewellSent) {
          endCall();
          return;
        }
        blockForConsent(error);
        return;
      }
      set({ caption: errorText(error, t`Could not speak that.`) });
    })
    .finally(() => {
      if (superseded()) return;
      if (blockedByConsent) return;
      // The caller cut in: the microphone is already theirs and their turn is on its way.
      if (bargedIn) return;
      // Everything written so far was said, but the run is still writing: wait for the rest
      // with the microphone as it was while speaking.
      if (replyStillWritten()) {
        set({ phase: "thinking" });
        deps.waitSound("start");
        return;
      }
      endTurn();
    });
}

/** The reply has been said: listen, after the echo guard where the microphone stayed shut. */
function endTurn(): void {
  if (hangUpAfterReply || Platform.OS !== "android") {
    void listen();
    return;
  }
  // The waiting sound of a pause between sentences must not play into the guard's quiet.
  if (state?.phase === "thinking") deps.waitSound("stop");
  guardThenListen();
}

/** The bot hung up: speak the goodbye it wrote, then end — the rest lands in the thread. */
function onCallEnded(ended: CallEnded): void {
  if (!state || switching || ended.callId !== callId || botEndedCall) return;
  hangUpAfterReply = true;
  botEndedCall = true;
  if (hangUpTimer) clearTimeout(hangUpTimer);
  hangUpTimer = setTimeout(endCall, CALL_FAREWELL_TIMEOUT_MS);
  // A reply still being said, as it is written or after it landed, ends before the goodbye.
  const afterReply = streamRunId !== null || state.phase === "speaking";
  sealStream();
  const farewell = ended.farewell?.trim();
  // Nothing to say: hang up instead of waiting out the fallback.
  if (!farewell) {
    endCall();
    return;
  }
  speakAndListen(farewell, { queue: afterReply });
}

/** This call's production deps; a hang-up or a newer call leaves them inert. */
function ownDeps(requestContext?: ApiRequestContext): CallDeps {
  const ownCallId = callId;
  return productionDeps({
    callId: ownCallId,
    generation: callSessionGeneration,
    requestContext,
    // The server rejected this call's session: stop listening instead of opening the
    // microphone for another turn. The next ordinary request handles the sign-out.
    onUnauthorized: (own) => {
      if (deps.send === own.send) endCall();
    },
    onFeedLost: () => {
      if (callId === ownCallId) endCall();
    },
  });
}
