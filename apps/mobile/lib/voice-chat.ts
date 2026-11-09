/**
 * Push-to-talk voice chat, with a hands-free mode that keeps listening like a
 * voice assistant: the microphone reopens after each reply, so the caller
 * talks whenever they want instead of holding the button for every turn.
 * Unlike the hands-free call loop in call-session, this session listens one
 * turn at a time and only while the caller holds the microphone or has
 * hands-free on.
 */

import {
  ACTIVE_RUN_STATUSES,
  abortableDelay,
  isRetryableError,
  newClientId,
  recognitionLocaleTag,
  reduceThreadSnapshot,
} from "@rakazo/core";
import { rpc } from "./api";
import { subscribeThread } from "./api-live";
import { readAloudText } from "./auto-speak";
import type { DictationGiveUp } from "./dictation";
import * as dictation from "./dictation";
import { deviceLanguage, getActiveUiLocale, t } from "./i18n";
import type { MobileSnapshot } from "./mobile-types";
import {
  finishServerDictation,
  listenServerDictation,
  serverTranscribeAvailable,
  stopServerDictation,
} from "./server-dictation";
import { errorText } from "./user-error";
import { createSpeechOwner, speakText, stopSpeaking } from "./voice";
import { DEFAULT_VOICE_CHAT_SCENARIO_ID, voiceChatScenario } from "./voice-chat-scenarios";

export type VoiceChatPhase = "idle" | "listening" | "thinking" | "speaking" | "not-ready";

/** The orb's look: waiting for the caller, hearing the caller, or answering. */
export type VoiceChatOrbVariant = "waiting" | "user" | "ai";

/**
 * Maps a session phase to the orb: the caller speaking is the only state that
 * counts as "user" — a silent microphone is still waiting, and thinking waits
 * with it.
 */
export function voiceChatOrbVariant(phase: VoiceChatPhase, heard: string): VoiceChatOrbVariant {
  if (phase === "speaking") return "ai";
  if (phase === "listening" && heard.trim()) return "user";
  return "waiting";
}

export type VoiceChatExchange = { role: "user" | "bot"; text: string; messageId?: string };

export type VoiceChatState = {
  botId: string;
  botName: string;
  phase: VoiceChatPhase;
  /** Hands-free listening is on: the microphone reopens after each reply. */
  handsFree: boolean;
  /** What the recognizer hears right now, before the turn is sent. */
  heard: string;
  exchanges: VoiceChatExchange[];
  /** A plain-language hint when the session cannot go on; null otherwise. */
  notice: string | null;
  /** The scenario picked for this session; the default attaches nothing. */
  scenarioId: string;
};

/** What one microphone session reports back: a running guess, then the finished turn. */
export type VoiceChatDictationHandlers = {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onGiveUp: (reason: DictationGiveUp) => void;
};

/** Everything that touches the device or the server, so the session stays testable. */
export type VoiceChatDeps = {
  /** On-device dictation for one turn. False when the device cannot recognise speech. */
  dictate: (handlers: VoiceChatDictationHandlers, signal: AbortSignal) => Promise<boolean>;
  /** Delivers the utterance heard so far as the finished turn. */
  finishDictation: () => void;
  stopDictation: () => void;
  /** Resolves with the run the message started, so only that run's reply is spoken. */
  send: (botId: string, text: string) => Promise<string | undefined>;
  /** Calls onReply for each new bot reply; onLost when the feed ends for good. */
  watch: (
    botId: string,
    onReply: (messageId: string, text: string) => void,
    onLost: () => void,
  ) => () => void;
  /** Reads a reply aloud; false when no voice is set up. */
  speak: (botId: string, text: string) => Promise<boolean>;
  /** Cuts the reply off, for a caller who talks over it. */
  stopSpeaking: () => void;
};

export type VoiceChatSession = {
  getState: () => VoiceChatState;
  subscribe: (listener: () => void) => () => void;
  start: (botId: string, botName: string) => void;
  /** Picks a scenario; its instruction rides on the next turn sent. */
  setScenario: (id: string) => void;
  /** Turns hands-free listening on or off; on opens the microphone between turns. */
  setHandsFree: (on: boolean) => void;
  /** Opens the microphone; a reply playing is cut off first. */
  pressToTalk: () => void;
  /** Sends what was heard so far, or closes the microphone when nothing was heard. */
  releaseToSend: () => void;
  /** Sends the last user turn again, as the regenerate action does. */
  resendLastUserTurn: () => void;
  /** Reads the latest bot reply aloud again. */
  speakLastReply: () => void;
  /** Stops the microphone and the speaker; the screen is going away. */
  end: () => void;
};

export function createVoiceChatSession(deps: VoiceChatDeps): VoiceChatSession {
  let state: VoiceChatState = {
    botId: "",
    botName: "",
    phase: "idle",
    handsFree: false,
    heard: "",
    exchanges: [],
    notice: null,
    scenarioId: DEFAULT_VOICE_CHAT_SCENARIO_ID,
  };
  const listeners = new Set<() => void>();
  /** Counts turns and sessions, so a late reply or speech settles over nothing. */
  let generation = 0;
  let turn: AbortController | null = null;
  let unwatch: (() => void) | null = null;
  /** The picked scenario's instruction, waiting for the next turn to carry it. */
  let pendingInstruction: string | null = null;

  function emit() {
    for (const listener of [...listeners]) listener();
  }

  function set(patch: Partial<VoiceChatState>) {
    state = { ...state, ...patch };
    emit();
  }

  function start(botId: string, botName: string) {
    end();
    generation += 1;
    const mine = generation;
    state = {
      botId,
      botName,
      phase: "idle",
      handsFree: false,
      heard: "",
      exchanges: [],
      notice: null,
      scenarioId: DEFAULT_VOICE_CHAT_SCENARIO_ID,
    };
    pendingInstruction = null;
    // A buffered feed event can still arrive after hang-up; only this session's
    // own generation may speak.
    unwatch = deps.watch(
      botId,
      (messageId, text) => {
        if (generation === mine) onReply(messageId, text);
      },
      () => {
        if (generation === mine) onWatchLost();
      },
    );
    emit();
  }

  function setScenario(id: string) {
    const scenario = voiceChatScenario(id);
    if (scenario.id === state.scenarioId) return;
    // The new instruction rides on the next turn; the transcript keeps
    // showing only the caller's own words.
    pendingInstruction = scenario.instruction;
    set({ scenarioId: scenario.id });
  }

  /**
   * Idle with hands-free on reopens the microphone, so the session keeps
   * listening until the caller switches it off. The phase is set first: a
   * turn that just settled still reports thinking or speaking.
   */
  function toIdle() {
    set({ phase: "idle", heard: "" });
    if (state.handsFree) beginListening();
  }

  function setHandsFree(on: boolean) {
    if (on === state.handsFree || !state.botId) return;
    set({ handsFree: on });
    if (!on) {
      // Switching off stops the microphone; a reply in flight keeps playing
      // and lands idle when it finishes.
      if (state.phase === "listening") {
        turn?.abort();
        deps.stopDictation();
        set({ phase: "idle", heard: "" });
      }
      return;
    }
    // Switching on opens the microphone when the session is between turns;
    // a reply or a pending send reopens it when it settles, through toIdle.
    if (state.phase === "idle") beginListening();
  }

  /** Opens the microphone for one turn, from a press or from hands-free. */
  function beginListening() {
    if (state.phase === "not-ready" || state.phase === "thinking") return;
    if (!state.botId) return;
    turn?.abort();
    const controller = new AbortController();
    turn = controller;
    const mine = generation;
    set({ phase: "listening", heard: "", notice: null });
    void deps
      .dictate(
        {
          onInterim: (text) => {
            if (generation === mine && state.phase === "listening") set({ heard: text });
          },
          onFinal: (text) => {
            if (generation === mine) void handleTranscript(text);
          },
          onGiveUp: (reason) => {
            if (generation !== mine) return;
            if (reason === "failed") {
              set({
                phase: "not-ready",
                handsFree: false,
                heard: "",
                notice: t(
                  "Allow speech recognition in Settings, or connect a voice provider in Voice settings.",
                ),
              });
              return;
            }
            // Silence ends the turn; hands-free reopens the microphone so
            // the caller can speak again without pressing anything.
            if (state.phase === "listening") toIdle();
          },
        },
        controller.signal,
      )
      .then((started) => {
        if (generation !== mine) return;
        if (started) return;
        // No recognizer at all: hands-free must not spin on a dead microphone.
        set({
          phase: "not-ready",
          handsFree: false,
          heard: "",
          notice: t(
            "Allow speech recognition in Settings, or connect a voice provider in Voice settings.",
          ),
        });
      })
      .catch((error: unknown) => {
        if (generation !== mine) return;
        // A listen that throws cannot recover by retrying: a persistent
        // failure would spin the microphone, so hands-free switches off
        // and the caller re-enables it from the microphone button.
        set({
          phase: "idle",
          handsFree: false,
          notice: errorText(error, t("Could not hear that.")),
        });
      });
  }

  /** Sends a turn, carrying a picked scenario's instruction exactly once. */
  async function sendWithScenario(text: string) {
    const prefix = pendingInstruction;
    pendingInstruction = null;
    await deps.send(state.botId, prefix ? `${prefix}\n\n${text}` : text);
  }

  function onWatchLost() {
    if (state.phase === "thinking") {
      toIdle();
      set({ notice: t("The connection dropped. Try again.") });
    }
  }

  function onReply(messageId: string, text: string) {
    if (state.exchanges.some((exchange) => exchange.messageId === messageId)) return;
    const mine = generation;
    set({
      phase: "speaking",
      exchanges: [...state.exchanges, { role: "bot", text, messageId }],
    });
    void deps
      .speak(state.botId, text)
      .then((spoken) => {
        if (generation !== mine) return;
        if (!spoken) {
          // No voice to answer with: hands-free switches off instead of
          // listening for turns that cannot be spoken back.
          set({
            phase: "idle",
            handsFree: false,
            notice: t("Add a voice provider in Voice settings."),
          });
          return;
        }
        // A reply playing when the caller presses the microphone was already
        // cut off into a new listen; only a reply still playing reopens it.
        if (state.phase === "speaking") toIdle();
      })
      .catch((error: unknown) => {
        if (generation !== mine) return;
        set({ phase: "idle", notice: errorText(error, t("Could not speak that.")) });
      });
  }

  function pressToTalk() {
    if (state.phase === "not-ready" || state.phase === "thinking") return;
    if (!state.botId) return;
    if (state.phase === "speaking") deps.stopSpeaking();
    beginListening();
  }

  function releaseToSend() {
    if (state.phase !== "listening") return;
    const text = state.heard.trim();
    if (!text) {
      deps.stopDictation();
      toIdle();
      return;
    }
    deps.finishDictation();
    if (state.phase === "listening") {
      // The recognizer had already ended, so no final is coming: send what was
      // heard instead of losing the turn.
      deps.stopDictation();
      void handleTranscript(text);
    }
  }

  async function handleTranscript(raw: string) {
    const text = raw.trim();
    if (!text) {
      if (state.phase === "listening") toIdle();
      return;
    }
    const mine = generation;
    set({
      phase: "thinking",
      heard: "",
      exchanges: [...state.exchanges, { role: "user", text }],
    });
    try {
      await sendWithScenario(text);
    } catch (error) {
      if (generation !== mine) return;
      toIdle();
      set({ notice: errorText(error, t("Try again.")) });
    }
  }

  function resendLastUserTurn() {
    if (state.phase === "thinking" || state.phase === "speaking") return;
    const last = [...state.exchanges].reverse().find((exchange) => exchange.role === "user");
    if (!last?.text || !state.botId) return;
    const mine = generation;
    set({ phase: "thinking", heard: "", notice: null });
    void sendWithScenario(last.text).catch((error: unknown) => {
      if (generation !== mine) return;
      toIdle();
      set({ notice: errorText(error, t("Try again.")) });
    });
  }

  function speakLastReply() {
    const last = [...state.exchanges].reverse().find((exchange) => exchange.role === "bot");
    if (!last?.text || !state.botId) return;
    if (state.phase === "speaking") deps.stopSpeaking();
    const mine = generation;
    set({ phase: "speaking", notice: null });
    void deps
      .speak(state.botId, last.text)
      .then((spoken) => {
        if (generation !== mine) return;
        if (state.phase !== "speaking") return;
        if (!spoken) {
          set({
            phase: "idle",
            handsFree: false,
            notice: t("Add a voice provider in Voice settings."),
          });
          return;
        }
        toIdle();
      })
      .catch((error: unknown) => {
        if (generation !== mine) return;
        set({ phase: "idle", notice: errorText(error, t("Could not speak that.")) });
      });
  }

  function end() {
    generation += 1;
    turn?.abort();
    turn = null;
    deps.stopDictation();
    deps.stopSpeaking();
    unwatch?.();
    unwatch = null;
    pendingInstruction = null;
    if (state.botId) set({ phase: "idle", handsFree: false, heard: "", notice: null });
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    setScenario,
    setHandsFree,
    pressToTalk,
    releaseToSend,
    resendLastUserTurn,
    speakLastReply,
    end,
  };
}

/** The newest bot reply in a thread snapshot, ignoring progress markers. */
function latestBotReply(
  messages: MobileSnapshot["messages"],
): MobileSnapshot["messages"][number] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "bot" && !message.id.startsWith("progress:")) return message;
  }
  return undefined;
}

/** Live feed for the voice chat, independent of whichever thread is on screen. */
function watchVoiceChatReplies(
  botId: string,
  onReply: (messageId: string, text: string) => void,
  onLost: () => void,
): () => void {
  const controller = new AbortController();
  void (async () => {
    let snapshot: MobileSnapshot | null = null;
    let lastSeen: string | null = null;
    let cursor = 0;
    while (!controller.signal.aborted) {
      try {
        if (!snapshot) {
          snapshot = await rpc("threads/get", { botId }, { signal: controller.signal });
          lastSeen = latestBotReply(snapshot.messages)?.id ?? null;
          cursor = snapshot.cursor ?? 0;
        }
        await subscribeThread(
          { botId },
          cursor,
          (event) => {
            if (typeof event.seq === "number") cursor = event.seq;
            const previous = snapshot;
            snapshot = reduceThreadSnapshot(snapshot, event) ?? snapshot;
            if (!snapshot || snapshot === previous) return;
            const message = latestBotReply(snapshot.messages);
            if (!message || message.id === lastSeen) return;
            // Wait for the message's own run to settle so half-written blocks are never spoken.
            const run =
              snapshot?.activeRuns?.find((active) => active.id === message.runId) ?? snapshot?.run;
            const fromAnotherRun = Boolean(message.runId && message.runId !== run?.id);
            if (!fromAnotherRun && run && ACTIVE_RUN_STATUSES.some((s) => s === run.status)) return;
            const text = readAloudText(message.blocks).trim();
            if (!text) return;
            lastSeen = message.id;
            onReply(message.id, text);
          },
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!isRetryableError(error)) {
          onLost();
          return;
        }
      }
      if (controller.signal.aborted) return;
      await abortableDelay(1_000, controller.signal).catch(() => undefined);
    }
  })().catch(() => undefined);
  return () => controller.abort();
}

/** The device's own speech recognition, which works with a speak-only voice provider. */
async function dictateTurn(
  handlers: VoiceChatDictationHandlers,
  signal: AbortSignal,
): Promise<boolean> {
  if (await dictation.available()) {
    const lang = recognitionLocaleTag(getActiveUiLocale(), await deviceLanguage());
    await dictation.listen({ ...handlers, signal, lang });
    return true;
  }
  // No on-device recognition (some Android ROMs ship without it): record a
  // clip and have the voice provider transcribe it instead.
  if (!(await serverTranscribeAvailable())) return false;
  await listenServerDictation({ ...handlers, signal });
  return true;
}

export function productionVoiceChatDeps(): VoiceChatDeps {
  // One owner per session: its hang-up and barge-in stop only its own speech,
  // never unrelated read-aloud that has since replaced it.
  const speechOwner = createSpeechOwner();
  return {
    dictate: dictateTurn,
    finishDictation: () => {
      dictation.finish();
      finishServerDictation();
    },
    stopDictation: () => {
      dictation.stop();
      stopServerDictation();
    },
    send: async (botId, text) => {
      const sent = await rpc("threads/send", { botId, clientNonce: newClientId(), text });
      return sent.runId;
    },
    watch: watchVoiceChatReplies,
    speak: (botId, text) => speakText(text, { botId, owner: speechOwner }),
    stopSpeaking: () => stopSpeaking(speechOwner),
  };
}
