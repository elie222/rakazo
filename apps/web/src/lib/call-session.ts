import { t } from "@lingui/core/macro";
import type { ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import {
  callClientNonce,
  isFarewell,
  isSecretAskBlock,
  runThreadSubscription,
  speechFromBlocks,
  spokenDecision,
  spokenMemory,
} from "@rakazo/core";
import { useSyncExternalStore } from "react";
import { dictation } from "./dictation.js";
import { rpc } from "./rpc.js";
import { isThreadSnapshotEvent, reduceThreadSnapshot } from "./thread-events.js";
import { speaker } from "./tts.js";

export type CallPhase = "listening" | "thinking" | "speaking";
export type CallExchange = { role: "user" | "bot"; text: string };

export interface CallState {
  botId: string;
  botName: string;
  botColor: string;
  startedAt: number;
  phase: CallPhase;
  muted: boolean;
  transcriptOpen: boolean;
  caption: string;
  heard: string;
  exchanges: CallExchange[];
}

const RUN_ACTIVE = ["running", "queued", "leased"];
/** How long a goodbye waits for a reply that may never come before hanging up anyway. */
const FAREWELL_TIMEOUT = 20_000;
/**
 * Quiet gap between the last audio frame and opening the microphone.
 * ponytail: one fixed delay for every room and output device; make it adaptive only
 * if a measured tail actually outruns it.
 */
export const ECHO_GUARD_MS = 600;
/** While audio plays, most of what the mic hears is the speaker: match on fewer words. */
const PLAYBACK_ECHO_RATIO = 0.4;
/** The only one-word turns worth cutting a reply short for. */
const INTERRUPT_WORDS = new Set(["stop", "wait", "hold on", "pause", "no"]);
/**
 * How long a phrase must stand mid-playback before it cuts the reply off. The silence
 * window that ends an utterance is far longer than a reply, so waiting for the final
 * transcript means the barge-in lands after the bot already finished talking.
 */
export const INTERIM_BARGE_IN_MS = 300;

let state: CallState | null = null;
/** Shared by every message this call sends, so the thread can group one call's exchange. */
let callId = "";
let transcribe = false;
let thread: ThreadSnapshot | null = null;
let feed: AbortController | null = null;
/** Every bot message already spoken this call: a streaming message updates many times. */
const spokenMessageIds = new Set<string>();
let unsubSpeech: (() => void) | null = null;
let unsubDictation: (() => void) | null = null;
let hangUpAfterReply = false;
/** The bot hung up itself: its farewell is the last thing this call speaks. */
let botEndedCall = false;
let hangUpTimer: ReturnType<typeof setTimeout> | null = null;
/** Pending echo guard: the microphone stays shut until it fires. */
let guardTimer: ReturnType<typeof setTimeout> | null = null;
/** Whether dictation is running, so playback can leave it open instead of restarting it. */
let micOpen = false;
/** The caller cut the reply off: there is no tail left to wait out before listening. */
let bargedIn = false;
/** A turn is in flight: its reply must be spoken even if the mic reopened meanwhile. */
let awaitingReply = false;
/** Counting down an interim phrase heard over the reply, before it counts as cutting in. */
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

export function startCall(call: {
  botId: string;
  botName: string;
  botColor?: string;
  transcribe: boolean;
}): void {
  endCall();
  callId = randomId();
  transcribe = call.transcribe;
  spokenMemory.clear();
  clearInterim();
  micOpen = false;
  bargedIn = false;
  awaitingReply = false;
  state = {
    botId: call.botId,
    botName: call.botName,
    botColor: call.botColor ?? "",
    startedAt: Date.now(),
    phase: "listening",
    muted: false,
    transcriptOpen: false,
    caption: "",
    heard: "",
    exchanges: [],
  };
  unsubSpeech = speaker.subscribe((speech) => {
    if (!state) return;
    if (speech.status === "speaking") {
      bargedIn = false;
      set({ phase: "speaking", caption: speech.caption ?? "" });
      // The mic stays open through playback so the caller can talk over the reply.
      void openMic();
    } else if (speech.status === "idle" && state.phase !== "listening" && !bargedIn) {
      set({ caption: "" });
      guardThenListen();
    }
    if (speech.error) set({ caption: speech.error });
  });
  unsubDictation = dictation.subscribe((heard) => {
    if (!state) return;
    if (heard.status === "listening") {
      set({ heard: pendingSecretAsk(thread) ? "" : heard.transcript });
      watchInterim(heard.transcript);
    } else clearInterim();
    if (heard.error) set({ caption: heard.error });
  });
  watchThread(call.botId);
  emit();
  void listen();
}

export function endCall(): void {
  // A caller hang-up closes the call server-side, which files the marker and the wrap-up
  // run. The bot's own end_call already did that, so only tell the server when it did not.
  if (state && !botEndedCall) {
    const { botId } = state;
    // Fire and forget: the card is going away either way, and the server is idempotent.
    void rpc.threads.endCall({ botId, callId }).catch(() => undefined);
  }
  feed?.abort();
  feed = null;
  hangUpAfterReply = false;
  botEndedCall = false;
  if (hangUpTimer) clearTimeout(hangUpTimer);
  hangUpTimer = null;
  if (guardTimer) clearTimeout(guardTimer);
  guardTimer = null;
  clearInterim();
  micOpen = false;
  bargedIn = false;
  awaitingReply = false;
  unsubSpeech?.();
  unsubDictation?.();
  unsubSpeech = null;
  unsubDictation = null;
  dictation.stop("cancel");
  speaker.stop();
  thread = null;
  spokenMessageIds.clear();
  spokenMemory.clear();
  if (!state) return;
  state = null;
  emit();
}

export function toggleMute(): void {
  if (!state) return;
  const muted = !state.muted;
  set({ muted });
  if (muted) {
    dictation.stop("cancel");
    micOpen = false;
    set({ heard: "" });
    return;
  }
  if (state.phase === "listening") void listen();
  else if (state.phase === "speaking") void openMic();
}

export function toggleTranscript(): void {
  if (!state) return;
  set({ transcriptOpen: !state.transcriptOpen });
}

/** Live feed for the bot on the call, independent of whichever thread is on screen. */
function watchThread(botId: string) {
  const controller = new AbortController();
  feed = controller;
  const load = async () => commit(await rpc.threads.get({ botId }, { signal: controller.signal }));
  void runThreadSubscription({
    signal: controller.signal,
    loadInitial: load,
    loadHead: () => rpc.threads.head({ botId }, { signal: controller.signal }),
    refresh: load,
    currentSnapshot: () => thread,
    subscribe: (cursor) => rpc.threads.subscribe({ botId, cursor }, { signal: controller.signal }),
    applyEvent: (event) => {
      if (isThreadSnapshotEvent(event)) commit(reduceThreadSnapshot(thread, event));
    },
    onEvent: (event) => {
      // The bot hung up: speak the farewell it wrote and stop there — the rest of its
      // work lands in the thread as chat, which the caller is no longer listening to.
      if (event.type !== "thread.call.ended" || event.payload.callId !== callId) return;
      if (botEndedCall) return;
      hangUpAfterReply = true;
      botEndedCall = true;
      if (hangUpTimer) clearTimeout(hangUpTimer);
      hangUpTimer = setTimeout(endCall, FAREWELL_TIMEOUT);
      speakFarewell(event.payload);
    },
  });
}

/** The bot's own goodbye: the last thing this call says before the speaker goes idle. */
function speakFarewell(payload: Record<string, unknown>) {
  if (!state) return;
  const farewell = typeof payload.farewell === "string" ? payload.farewell.trim() : "";
  const messageId = typeof payload.messageId === "string" ? payload.messageId : undefined;
  if (messageId) spokenMessageIds.add(messageId);
  // Nothing to say: hang up instead of waiting out the fallback.
  if (!farewell) {
    endCall();
    return;
  }
  awaitingReply = false;
  set({ exchanges: [...state.exchanges, { role: "bot", text: farewell }], heard: "" });
  spokenMemory.remember(farewell);
  void speaker.speak(farewell, { botId: state.botId, messageId });
}

function commit(next: ThreadSnapshot | null) {
  if (!next) return null;
  thread = next;
  reactToThread();
  return next;
}

/** The tail of playback reaches the microphone after the audio element ends. */
function guardThenListen() {
  // Dictation ran right through playback: there is no shut mic to hold closed.
  if (micOpen) {
    void listen();
    return;
  }
  if (guardTimer) clearTimeout(guardTimer);
  guardTimer = setTimeout(() => {
    guardTimer = null;
    void listen();
  }, ECHO_GUARD_MS);
}

async function listen() {
  if (!state) return;
  // The caller said goodbye: every path back to listening hangs up instead.
  if (hangUpAfterReply) {
    endCall();
    return;
  }
  // A reply still playing owns the audio session; its idle event calls back here.
  if (speaker.isSpeaking()) return;
  // A guard is already counting down the quiet gap; it calls back here when it ends.
  if (guardTimer) return;
  set({ phase: "listening", heard: "" });
  speaker.stop();
  if (state.muted || pendingSecretAsk(thread)) {
    dictation.stop("cancel");
    micOpen = false;
    return;
  }
  await openMic();
}

/** Starts dictation unless it is already running, muted, or waiting on a typed secret. */
async function openMic() {
  if (!state || micOpen || state.muted || pendingSecretAsk(thread)) return;
  micOpen = true;
  try {
    await dictation.listen({
      mode: "endpoint",
      transcribe,
      onFinal: (text) => void handleTranscript(text),
    });
  } catch (error) {
    micOpen = false;
    set({ caption: errorText(error, t`Microphone failed`) });
  }
}

async function handleTranscript(text: string) {
  if (!state) return;
  // Dictation stopped itself to deliver this final.
  micOpen = false;
  if (!text.trim()) {
    void listen();
    return;
  }
  if (state.phase === "speaking") {
    if (!isBargeIn(text)) {
      set({ heard: "" });
      void openMic();
      return;
    }
    // The caller talked over the reply: cut the audio, and never resume that message.
    bargedIn = true;
    speaker.stop();
    set({ phase: "thinking", caption: "" });
  }
  dictation.stop("submit");
  // The microphone caught the reply, not the caller: drop it and keep listening.
  if (spokenMemory.isEcho(text)) {
    set({ heard: "" });
    void listen();
    return;
  }
  if (pendingSecretAsk(thread)) {
    set({ heard: "", caption: t`Hang up, then enter the code on screen.` });
    return;
  }
  const { botId, exchanges } = state;
  const askId = latestAskId(thread);
  const askMessage = thread?.messages.find((message) => message.id === askId);
  // Captured now: a call started while this is in flight must not re-attach the new feed.
  const callFeed = feed;
  const closing = isFarewell(text);
  awaitingReply = true;
  set({ heard: text, phase: "thinking", exchanges: [...exchanges, { role: "user", text }] });
  if (closing) {
    hangUpAfterReply = true;
    hangUpTimer = setTimeout(endCall, FAREWELL_TIMEOUT);
  }
  try {
    if (askMessage) {
      await rpc.threads.answer({
        botId,
        runId: askMessage.runId ?? "",
        messageId: askMessage.id,
        answer: spokenDecision(text) ?? text,
      });
    } else if (runActive(thread)) {
      await rpc.threads.followUp({ botId, text, clientNonce: callClientNonce(callId) });
    } else {
      await rpc.threads.send({ botId, clientNonce: callClientNonce(callId), text });
    }
    if (state?.botId !== botId) return;
    commit(await rpc.threads.get({ botId }, { signal: callFeed?.signal }));
  } catch (error) {
    if (state?.botId !== botId) return;
    awaitingReply = false;
    set({ caption: errorText(error, t`Could not send that`) });
    void listen();
  }
}

/**
 * True when a transcript heard during playback is the caller cutting in rather than
 * the reply leaking back into the mic: a real sentence, or a short interruption word.
 */
function isBargeIn(text: string): boolean {
  if (spokenMemory.isEcho(text, PLAYBACK_ECHO_RATIO)) return false;
  const cleaned = cleanWords(text);
  return cleaned.includes(" ") || INTERRUPT_WORDS.has(cleaned);
}

function cleanWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * An interim is a guess Chrome revises word by word, so a single stray word is never
 * enough: only a phrase that is not the reply leaking back cuts playback short.
 */
function isInterimBargeIn(text: string): boolean {
  return cleanWords(text).includes(" ") && !spokenMemory.isEcho(text, PLAYBACK_ECHO_RATIO);
}

/**
 * Interim results are the only signal that arrives while the caller is still talking.
 * A qualifying phrase that stands for INTERIM_BARGE_IN_MS stops the audio at once; the
 * dictation session keeps running, so its silence window finishes the utterance and
 * handleTranscript sends it as the next turn.
 */
function watchInterim(text: string) {
  if (state?.phase !== "speaking") return;
  if (!isInterimBargeIn(text)) {
    clearInterim();
    return;
  }
  if (interimTimer) return;
  interimTimer = setTimeout(() => {
    interimTimer = null;
    if (state?.phase !== "speaking") return;
    // Never resume the cut-off message, and keep the idle it emits from reopening the mic.
    bargedIn = true;
    speaker.stop();
    set({ phase: "listening", caption: "" });
  }, INTERIM_BARGE_IN_MS);
}

function clearInterim() {
  if (interimTimer) clearTimeout(interimTimer);
  interimTimer = null;
}

/**
 * Speak whatever the call's bot said last. A call never speaks tool activity: the
 * card's phase indicator is the only feedback, so nothing talks over the caller.
 */
function reactToThread() {
  if (!state) return;
  // The bot already said goodbye: neither its marker nor the work it files after it is spoken.
  if (botEndedCall) return;
  if (pendingSecretAsk(thread)) {
    dictation.stop("cancel");
    micOpen = false;
    set({ heard: "" });
  }
  // A turn sent back to listening mid-flight must not drop the reply it is waiting for.
  if (state.phase === "listening" && !awaitingReply) return;
  const { botId } = state;
  const messages = thread?.messages ?? [];
  const lastBot = [...messages].reverse().find((message) => message.role === "bot");
  if (lastBot && !spokenMessageIds.has(lastBot.id) && replyFinished(lastBot)) {
    const text = speechFromBlocks(lastBot.blocks);
    const ask = lastBot.blocks.find((block) => block.kind === "ask" && block.status !== "answered");
    const secretAsk = ask && isSecretAskBlock(ask);
    if (text) {
      // Never spoken again, interrupted or not.
      spokenMessageIds.add(lastBot.id);
      awaitingReply = false;
      set({ exchanges: [...state.exchanges, { role: "bot", text }], heard: "" });
      spokenMemory.remember(text);
      void speaker.speak(
        secretAsk
          ? `${text}. ${t`Hang up first, then enter the code on screen.`}`
          : ask
            ? `${text}. ${t`Say yes or no, or answer in a sentence.`}`
            : text,
        { botId, messageId: lastBot.id },
      );
      return;
    }
    if (!runActive(thread)) {
      spokenMessageIds.add(lastBot.id);
      awaitingReply = false;
      void listen();
    }
  }
}

/**
 * A reply is only whole once its own run stopped. Speaking a message the run is
 * still streaming clips it, and later updates of the same id never get a turn.
 */
function replyFinished(message: ThreadMessage) {
  const run = thread?.run;
  if (!run) return true;
  if (message.runId && message.runId !== run.id) return true;
  return !RUN_ACTIVE.includes(run.status);
}

function runActive(snapshot: ThreadSnapshot | null) {
  return Boolean(snapshot?.run && RUN_ACTIVE.includes(snapshot.run.status));
}

function pendingSecretAsk(snapshot: ThreadSnapshot | null) {
  const askId = latestAskId(snapshot);
  const askMessage = snapshot?.messages.find((message) => message.id === askId);
  return Boolean(
    askMessage?.blocks.some(
      (block) => block.kind === "ask" && isSecretAskBlock(block) && block.status !== "answered",
    ),
  );
}

function latestAskId(snapshot: ThreadSnapshot | null): string | null {
  if (snapshot?.run?.status !== "waiting_input") return null;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (message?.runId !== snapshot.run.id) continue;
    if (message.blocks.some((block) => block.kind === "ask" && block.status !== "answered")) {
      return message.id;
    }
  }
  return null;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function randomId(): string {
  const webCrypto = globalThis.crypto;
  return typeof webCrypto?.randomUUID === "function"
    ? webCrypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
