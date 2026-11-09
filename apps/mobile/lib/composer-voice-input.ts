/**
 * Tap-or-hold voice input for the composer.
 *
 * - A tap starts dictation; the turn ends on the quiet gap and its text lands
 *   in the draft, where the caller can edit it before sending.
 * - Holding past the threshold makes it a voice message instead: the text is
 *   sent as soon as the caller lets go (or the quiet gap ends the turn).
 * - A tap while dictating cancels it.
 *
 * The dictate step mirrors the call loop's: on-device recognition first, so
 * this works with a speak-only voice provider. When the device has no
 * recognition of its own, a clip is recorded and the voice provider
 * transcribes it instead.
 */

import { recognitionLocaleTag } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import type { DictationGiveUp } from "./dictation";
import * as dictation from "./dictation";
import { deviceLanguage, getActiveUiLocale } from "./i18n";
import {
  finishServerDictation,
  listenServerDictation,
  serverTranscribeAvailable,
  stopServerDictation,
} from "./server-dictation";

/** A press held at least this long is a voice message, not a tap to dictate. */
export const COMPOSER_VOICE_HOLD_MS = 400;

export type ComposerVoiceInputHandlers = {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onGiveUp: (reason: DictationGiveUp) => void;
};

export type ComposerVoiceInputDeps = {
  /** On-device dictation for one turn. False when the device cannot recognise speech. */
  dictate: (handlers: ComposerVoiceInputHandlers, signal: AbortSignal) => Promise<boolean>;
  /** Delivers the utterance heard so far as the finished turn. */
  finishDictation: () => void;
  stopDictation: () => void;
};

export function useComposerVoiceInput(
  deps: ComposerVoiceInputDeps,
  callbacks: {
    /** Interim and finished text, for the draft. */
    onFill: (text: string) => void;
    /** Finished text from a held press, to send at once. */
    onSend: (text: string) => void;
    /** Speech recognition is unavailable or gave up. */
    onNotReady: () => void;
  },
) {
  const [listening, setListening] = useState(false);
  const modeRef = useRef<"fill" | "send" | null>(null);
  const pressedRef = useRef(false);
  const pressStartRef = useRef(0);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const controllerRef = useRef<AbortController | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  function clearHoldTimer() {
    clearTimeout(holdTimerRef.current);
    holdTimerRef.current = undefined;
  }

  function finishTurn(text: string) {
    const mode = modeRef.current;
    modeRef.current = null;
    controllerRef.current = null;
    clearHoldTimer();
    setListening(false);
    if (!text.trim()) return;
    if (mode === "send") callbacksRef.current.onSend(text);
    else callbacksRef.current.onFill(text);
  }

  async function pressIn() {
    if (listening) {
      // A tap while dictating cancels it.
      controllerRef.current?.abort();
      deps.stopDictation();
      modeRef.current = null;
      controllerRef.current = null;
      clearHoldTimer();
      setListening(false);
      return;
    }
    pressedRef.current = true;
    pressStartRef.current = Date.now();
    modeRef.current = "fill";
    const controller = new AbortController();
    controllerRef.current = controller;
    setListening(true);
    // Still held after the threshold: a quiet gap ending the turn now sends it.
    holdTimerRef.current = setTimeout(() => {
      if (pressedRef.current && controllerRef.current === controller) {
        modeRef.current = "send";
      }
    }, COMPOSER_VOICE_HOLD_MS);
    let started = false;
    try {
      started = await deps.dictate(
        {
          onInterim: (text) => {
            if (controllerRef.current === controller) callbacksRef.current.onFill(text);
          },
          onFinal: (text) => {
            if (controllerRef.current === controller) finishTurn(text);
          },
          onGiveUp: (reason) => {
            if (controllerRef.current !== controller) return;
            modeRef.current = null;
            controllerRef.current = null;
            clearHoldTimer();
            setListening(false);
            if (reason === "failed") callbacksRef.current.onNotReady();
          },
        },
        controller.signal,
      );
    } catch {
      if (controllerRef.current !== controller) return;
      modeRef.current = null;
      controllerRef.current = null;
      clearHoldTimer();
      setListening(false);
      callbacksRef.current.onNotReady();
      return;
    }
    if (controllerRef.current !== controller) return;
    if (!started) {
      modeRef.current = null;
      controllerRef.current = null;
      clearHoldTimer();
      setListening(false);
      callbacksRef.current.onNotReady();
    }
  }

  function pressOut() {
    pressedRef.current = false;
    if (!listening || !controllerRef.current) return;
    if (Date.now() - pressStartRef.current >= COMPOSER_VOICE_HOLD_MS) {
      // Held: send what was heard when the recognizer delivers it.
      modeRef.current = "send";
      deps.finishDictation();
    }
    // A tap keeps listening in fill mode until the quiet gap ends the turn.
  }

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      clearHoldTimer();
      deps.stopDictation();
    },
    [deps],
  );

  return { listening, pressIn, pressOut };
}

export const productionComposerVoiceInputDeps: ComposerVoiceInputDeps = {
  dictate: async (handlers, signal) => {
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
  },
  finishDictation: () => {
    dictation.finish();
    finishServerDictation();
  },
  stopDictation: () => {
    dictation.stop();
    stopServerDictation();
  },
};
