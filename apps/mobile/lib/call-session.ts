import { ph, t } from "@lingui/core/macro";
import type { BotAvatarSet } from "@rakazo/contracts";
import type { CallExchange } from "@rakazo/core";
import {
  ACTIVE_RUN_STATUSES,
  AiConsentBlocked,
  abortableDelay,
  CALL_FAREWELL_TIMEOUT_MS,
  callClientNonce,
  callTurn,
  createCallSendTracker,
  createInterimBargeIn,
  isCallBargeIn,
  isFarewell,
  isRetryableError,
  latestSpokenCallReply,
  MAX_TRANSCRIPTION_RESPONSE_BYTES,
  newClientId,
  pendingCallSecretAsk,
  readJsonObjectWithin,
  recognitionLocaleTag,
  reduceThreadSnapshot,
  retryDelayMs,
  spokenMemory,
} from "@rakazo/core";
import type { AudioRecorder } from "expo-audio";
import { File } from "expo-file-system";
import { useSyncExternalStore } from "react";
import type { ApiRequestContext } from "./api";
import { captureApiRequestContext, rpc } from "./api";
import { subscribeThread } from "./api-live";
import { configureSessionEndHangUp } from "./api-server";
import type { CallCue } from "./call-sounds";
import {
  playCallCue,
  preloadWaitSound,
  releaseWaitSound,
  startWaitSound,
  stopWaitSound,
} from "./call-sounds";
import type { DictationGiveUp } from "./dictation";
import * as dictation from "./dictation";
import { hapticImpact, hapticSuccess } from "./haptics";
import { deviceLanguage, getActiveUiLocale } from "./i18n";
import type { MobileSnapshot } from "./mobile-types";
import { blockText } from "./mobile-types";
import { reportMobileError } from "./monitoring";
import { fetchServer } from "./server-headers";
import { currentSessionGeneration, subscribeSessionGeneration } from "./session";
import { errorText, voiceAccountErrorText } from "./user-error";
import type { SpeechOwner } from "./voice";
import {
  createSpeechOwner,
  ensureVoiceConsent,
  setCallAudio,
  setDictationAudio,
  speakText,
  stopSpeaking,
} from "./voice";

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

export type CallClip = { base64: string; mimeType: string };

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
  record: (signal: AbortSignal) => Promise<CallClip | null>;
  transcribe: (clip: CallClip, signal: AbortSignal) => Promise<string>;
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
  speak: (botId: string, text: string) => Promise<void>;
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

/** A call that cannot reach the microphone or the server this many turns in a row hangs up. */
const MAX_TURN_FAILURES = 3;

/** A turn failure the caption already explains and the server logged if it answered: not a bug. */
export class ExpectedTurnFailure extends Error {}

/** A dropped live feed is reconnected from the last seq it saw, backing off as it retries. */
const FEED_RETRY_MIN_MS = 250;
const FEED_RETRY_MAX_MS = 5_000;

// ponytail: naive fixed-threshold endpointing on the fallback path only. Swap for a VAD
// model if rooms with steady background noise start cutting people off mid-sentence.
const SPEECH_LEVEL_DB = -35;
const SILENCE_HANG_MS = 1_200;
const METER_POLL_MS = 200;
/** How long a starting recorder may go without a level (web reports one once it records). */
const METER_START_MS = 1_000;
const MAX_CLIP_MS = 30_000;
/** A dictated message stays well inside the server's transcription size limit. */
const MAX_DICTATION_MS = 5 * 60_000;

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
let deps: CallDeps = productionDeps();
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
/** Counting down a phrase heard over the reply, before it counts as cutting in. */
const interim = createInterimBargeIn(() => {
  if (state?.phase !== "speaking") return;
  bargedIn = true;
  deps.stopSpeaking();
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
  deps = { ...productionDeps(call.requestContext), ...overrides };
  switchBot = call.switchBot;
  callId = call.answered?.callId ?? newClientId();
  callRunId = null;
  canTranscribe = call.transcribe ?? true;
  onDevice = null;
  recognitionFailures = 0;
  micOpen = false;
  bargedIn = false;
  spokenMemory.clear();
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
  if (hangUpTimer) clearTimeout(hangUpTimer);
  hangUpTimer = null;
  hangUpAfterReply = false;
  farewellSent = false;
  consentBlocked = false;
  botEndedCall = false;
  callRunId = null;
  spokenMessageId = null;
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

/** How long a sign-out or server switch waits for the hang-up before it continues anyway. */
export const SIGN_OUT_HANG_UP_MS = 3_000;

/**
 * Hangs up while the session still exists, waiting at most `SIGN_OUT_HANG_UP_MS` for pending
 * sends and the hang-up. What follows — a sign-out or a server switch — discards the session,
 * so a hang-up still queued after that is dropped: by then its request may carry no one's or
 * another user's token.
 */
export async function endCallBeforeSessionEnd(): Promise<void> {
  endCall();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(hangUps),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SIGN_OUT_HANG_UP_MS);
    }),
  ]);
  clearTimeout(timer);
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
            // Recording must wait for playback; recognition can still hear a barge-in.
            if (state?.phase !== "speaking" || onDevice !== false) void openMic();
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
    }
    // Muting or hanging up while the device was deciding: no microphone after all.
    if (!mine() || !state || state.muted) {
      micOpen = false;
      return;
    }
    if (!canTranscribe) {
      micOpen = false;
      set({
        caption: t`Allow speech recognition in Settings, or connect ElevenLabs, OpenAI, or Fish Audio.`,
      });
      return;
    }
    const clip = await deps.record(controller.signal);
    if (!mine()) return;
    const text = clip ? await deps.transcribe(clip, controller.signal) : "";
    if (!mine()) return;
    micOpen = false;
    if (recognitionFailures < 2) onDevice = null;
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
    void listen();
    return;
  }
  if (state.phase === "speaking") {
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
    set({ phase: "thinking", caption: "" });
  }
  if (spokenMemory.isEcho(text)) {
    set({ heard: "" });
    void listen();
    return;
  }
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
  interim.hear(text);
}

function onReply(messageId: string, text: string, runId?: string): void {
  // Work the bot files after hanging up belongs in the thread, not in the caller's ear.
  if (!state || switching || botEndedCall || messageId === spokenMessageId) return;
  // A reply to something typed into the thread mid-call belongs on screen only.
  if (callRunId && runId && runId !== callRunId) return;
  spokenMessageId = messageId;
  speakAndListen(text);
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
  if (!heldForCode) return;
  heldForCode = false;
  if (state.phase === "listening" && !micOpen && !opening) void listen();
}

/** The bot on the line says it is handing over, then this call hangs up and the other bot rings. */
async function switchCall(target: CallSwitch, heard: string): Promise<void> {
  if (!state || switching) return;
  switching = true;
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

function speakAndListen(text: string): void {
  if (!state) return;
  const { botId } = state;
  const speakingCallId = callId;
  // Bump before anything else: this attempt supersedes all older ones, even if it then
  // declines to speak, so only the newest speech below may run its handlers.
  const speechId = ++speechSeq;
  // An older speech can settle long after a newer one started, because its barge-in
  // stop need not resolve it: it must not act on the newer speech's call.
  const superseded = () =>
    state?.botId !== botId || callId !== speakingCallId || speechSeq !== speechId;
  let blockedByConsent = false;
  bargedIn = false;
  interim.clear();
  set({ exchanges: [...state.exchanges, { role: "bot", text }] });
  // A prior disclosure refuse stays muted until unmute; do not re-open speech consent.
  if (consentBlocked) {
    set({ phase: "listening", heard: "" });
    return;
  }
  spokenMemory.remember(text);
  // Only the on-device path can hear the caller over the reply; the recorder would just
  // record the speaker, so it stays shut until playback ends.
  if (!onDevice) {
    turn?.abort();
    turn = null;
    micOpen = false;
  }
  set({ phase: "speaking", heard: "" });
  if (onDevice) void openMic();
  void deps
    .speak(botId, text)
    .catch((error: unknown) => {
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
      void listen();
    });
}

/** The bot hung up: speak the goodbye it wrote, then end — the rest lands in the thread. */
function onCallEnded(ended: CallEnded): void {
  if (!state || switching || ended.callId !== callId || botEndedCall) return;
  hangUpAfterReply = true;
  botEndedCall = true;
  if (hangUpTimer) clearTimeout(hangUpTimer);
  hangUpTimer = setTimeout(endCall, CALL_FAREWELL_TIMEOUT_MS);
  const farewell = ended.farewell?.trim();
  // Nothing to say: hang up instead of waiting out the fallback.
  if (!farewell) {
    endCall();
    return;
  }
  speakAndListen(farewell);
}

function productionDeps(requestContext?: ApiRequestContext): CallDeps {
  // One owner per call: its hang-up and barge-in stop only its own speech, never
  // unrelated read-aloud that has since replaced it.
  const speechOwner = createSpeechOwner();
  // A late request of this call fails instead of going out with a newer session.
  const generation = callSessionGeneration;
  const callContext = async () => {
    const context = requestContext ?? (await captureApiRequestContext());
    if (context.sessionGeneration !== generation || currentSessionGeneration() !== generation)
      throw new Error(t`Something went wrong. Try again.`);
    return context;
  };
  // The server rejected this call's session: stop listening instead of opening the
  // microphone for another turn. The next ordinary request handles the sign-out.
  const endOnUnauthorized = async <T>(request: Promise<T>): Promise<T> => {
    try {
      return await request;
    } catch (error) {
      if ((error as { status?: unknown }).status === 401 && deps.send === own.send) endCall();
      throw error;
    }
  };
  const own: CallDeps = {
    dictate: dictateTurn,
    record: async (signal) => {
      await ensureVoiceConsent(await callContext());
      return recordClip(signal);
    },
    transcribe: async (clip, signal) => transcribeClip(clip, signal, await callContext()),
    send: (botId, text, clientNonce) =>
      endOnUnauthorized(
        callContext().then(async (requestContext) => {
          const sent = await rpc("threads/send", { botId, clientNonce, text }, { requestContext });
          return sent.runId;
        }),
      ),
    answer: (botId, ask, clientNonce) =>
      endOnUnauthorized(
        callContext().then(async (requestContext) => {
          await rpc("threads/answer", { botId, ...ask, clientNonce }, { requestContext });
        }),
      ),
    followUp: (botId, text, clientNonce) =>
      endOnUnauthorized(
        callContext().then(async (requestContext) => {
          await rpc("threads/followUp", { botId, text, clientNonce }, { requestContext });
        }),
      ),
    endCall: async (botId, id) => closeCall(botId, id, await callContext()),
    speak: (botId, text) => speakReply(botId, text, speechOwner, requestContext),
    stopSpeaking: () => stopSpeaking(speechOwner),
    audio: setCallAudio,
    cue: (cue) => playCallCue(cue, { duringCall: true }),
    waitSound: (action) => {
      if (action === "start") void startWaitSound().catch(() => undefined);
      else if (action === "stop") stopWaitSound();
      else if (action === "preload") void preloadWaitSound().catch(() => undefined);
      else releaseWaitSound();
    },
    watch: (botId, onReply, onEnded, onThread) =>
      watchReplies(botId, onReply, onEnded, onThread, requestContext),
  };
  return own;
}

/** The device's own speech recognition, which works with a speak-only voice provider. */
async function dictateTurn(handlers: DictationHandlers, signal: AbortSignal): Promise<boolean> {
  if (!(await dictation.available())) return false;
  const lang = recognitionLocaleTag(getActiveUiLocale(), await deviceLanguage());
  await dictation.listen({ ...handlers, signal, lang, call: true });
  return true;
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
): Promise<CallClip | null> {
  const { AudioModule, RecordingPresets } = await import("expo-audio");
  if (signal.aborted) return null;
  const permission = await AudioModule.requestRecordingPermissionsAsync();
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
    recorder = new AudioModule.AudioRecorder({
      ...RecordingPresets.HIGH_QUALITY,
      isMeteringEnabled: true,
    });
    await recorder.prepareToRecordAsync();
    // A dictation stopped before the microphone opened has nothing to send.
    if (signal.aborted || until?.aborted) return null;
    recorder.record();
    let quietMs = 0;
    let metered = false;
    for (
      let elapsed = 0;
      elapsed < maxMs && !signal.aborted && !until?.aborted;
      elapsed += METER_POLL_MS
    ) {
      await abortableDelay(METER_POLL_MS, signal);
      if (signal.aborted || until?.aborted) break;
      // A missing level is unknown, not 0 dB: a stand-in that loud hears speech in
      // silence and holds the clip to the cap. A recorder may still be starting; once it
      // has reported a level, or never does, nothing is left to endpoint on, so stop.
      // A dictated clip has `until` to end it, so it keeps recording.
      const level = recorder.getStatus().metering;
      if (level === undefined) {
        if (until) continue;
        if (metered || elapsed + METER_POLL_MS >= METER_START_MS) break;
        continue;
      }
      metered = true;
      if (level > SPEECH_LEVEL_DB) {
        heardSpeech = true;
        quietMs = 0;
      } else if (heardSpeech && !until) {
        quietMs += METER_POLL_MS;
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
    const file = new File(uri);
    const base64 = await file.base64();
    deleteQuietly(uri);
    return { base64, mimeType: "audio/m4a" };
  } finally {
    recorder?.release();
    if (recordingTurn === signal) {
      recordingTurn = undefined;
      await setDictationAudio(false);
    }
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

export async function transcribeClip(
  clip: CallClip,
  signal: AbortSignal,
  requestContext: ApiRequestContext,
): Promise<string> {
  const { apiBase, headers } = requestContext;
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

async function closeCall(
  botId: string,
  id: string,
  requestContext: ApiRequestContext,
): Promise<void> {
  await rpc("threads/endCall", { botId, callId: id }, { requestContext });
}

async function speakReply(
  botId: string,
  text: string,
  owner: SpeechOwner,
  requestContext?: ApiRequestContext,
): Promise<void> {
  if (!(await speakText(text, { botId, owner, requestContext }))) {
    throw new Error(t`Add a voice provider in Voice settings.`);
  }
}

/** Live feed for the bot on the call, independent of whichever thread is on screen. */
function watchReplies(
  botId: string,
  onNewReply: (messageId: string, text: string, runId?: string) => void,
  onEnded: (ended: CallEnded) => void,
  onThread: (thread: MobileSnapshot) => void,
  requestContext?: ApiRequestContext,
): () => void {
  const controller = new AbortController();
  const watchedCallId = callId;
  void (async () => {
    let snapshot: MobileSnapshot | null = null;
    let lastSeen: string | null = null;
    let cursor = 0;
    let retry = FEED_RETRY_MIN_MS;
    let failure: unknown;
    let firstLoadFailures = 0;
    // The stream returns on an idle timeout as well as on a real failure, and a call
    // outlives both: pick it back up from the last seq until the caller hangs up. The
    // first snapshot is loaded in here too, so a failed load retries instead of
    // leaving the call with an open microphone and no feed.
    while (!controller.signal.aborted) {
      try {
        if (!snapshot) {
          snapshot = await rpc(
            "threads/get",
            { botId },
            { signal: controller.signal, requestContext },
          );
          lastSeen = latestSpokenCallReply(snapshot.messages, watchedCallId)?.id ?? null;
          cursor = snapshot.cursor ?? 0;
          onThread(snapshot);
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
            const previous = snapshot;
            snapshot = reduceThreadSnapshot(snapshot, event) ?? snapshot;
            if (!snapshot) return;
            if (snapshot !== previous) onThread(snapshot);
            const message = latestSpokenCallReply(snapshot.messages, watchedCallId);
            if (!message || message.id === lastSeen) return;
            // Wait for the message's own run to settle so half-written blocks are never
            // spoken; another run still working says nothing about this one.
            // An answered question can resume a run behind the one the thread shows first, so
            // look the message's run up among every active run.
            const run =
              snapshot?.activeRuns?.find((active) => active.id === message.runId) ?? snapshot?.run;
            const fromAnotherRun = Boolean(message.runId && message.runId !== run?.id);
            if (!fromAnotherRun && run && ACTIVE_RUN_STATUSES.some((s) => s === run.status)) return;
            const text = blockText(message).trim();
            if (!text) return;
            lastSeen = message.id;
            onNewReply(message.id, text, message.runId);
          },
          controller.signal,
          requestContext,
        );
        retry = FEED_RETRY_MIN_MS;
        failure = undefined;
      } catch (error) {
        if (controller.signal.aborted) return;
        // A 4xx other than 408/429 is the server's answer; asking again only polls it. Without
        // a first snapshot the microphone stays shut, so the call cannot go on: hang it up, from
        // the caller's side so the server is told. A first load that keeps failing ends it too,
        // after as many tries as a run of failed turns.
        const giveUp =
          !isRetryableError(error) || (!snapshot && ++firstLoadFailures >= MAX_TURN_FAILURES);
        if (giveUp) {
          if (!snapshot && callId === watchedCallId) endCall();
          return;
        }
        retry = Math.min(FEED_RETRY_MAX_MS, retry * 2);
        failure = error;
      }
      if (controller.signal.aborted) return;
      await abortableDelay(retryDelayMs(failure, retry), controller.signal);
    }
  })().catch(() => undefined);
  return () => controller.abort();
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
