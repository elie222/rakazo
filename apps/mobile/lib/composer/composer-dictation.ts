import { useLingui } from "@lingui/react/macro";
import {
  AiConsentBlocked,
  recognitionLocaleTag,
  requestDeadline,
  VOICE_RESPONSE_TIMEOUT_MS,
} from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import { useNavigation, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, AppState } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { captureApiRequestContext, rpc } from "../api/api";
import { currentSessionGeneration } from "../api/session";
import { errorText } from "../api/user-error";
import { deleteQuietly, recordAudio, recordClip, transcribeClip } from "../calls/call-session";
import { resolveVoiceCallPlan } from "../calls/voice-call-entry";
import { deviceLanguage, getActiveUiLocale } from "../i18n/i18n";
import { appleTranscriber } from "../voice/apple-transcription";
import { loadDeviceVoiceEnabled } from "../voice/device-voice";
import * as dictation from "../voice/dictation";
import { ensureVoiceConsent } from "../voice/voice";
import { QUIET_LEVELS, withLevel } from "./dictation-levels";

/** A pause long enough to think in; one this long, or a mic that never hears anything, ends it. */
const DICTATION_PAUSE_MS = 30_000;

/** A short wait: a slow server must not hold up words already recorded. */
const WORDS_TIMEOUT_MS = 3_000;

/** `preparing`: the phone readies its speech model before the mic opens; a tap still cancels. */
export type ComposerDictationStatus = "idle" | "preparing" | "listening" | "transcribing";

/** How long a session hidden during setup waits for the app to come back from a prompt. */
const RETURN_FROM_PROMPT_MS = 1_000;

function untilActive(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      subscription.remove();
      resolve();
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") done();
    });
    const timer = setTimeout(done, timeoutMs);
  });
}

type Session = {
  cancel: AbortController;
  finish: () => void;
  /** Permissions are settled and the microphone is in use. */
  live: boolean;
  /** The clip is recorded and its transcription is in flight. */
  transcribing: boolean;
  /** The app is in the background while setup is still running. */
  hidden: boolean;
};

/**
 * Tap to dictate into the message box, then finish or cancel. On iOS 26 the phone transcribes
 * the recording once you finish. Elsewhere it takes the path a call would: the phone's live
 * recognizer when device voice is on, otherwise the connected voice provider.
 */
export function useComposerDictation({
  disabled,
  onWords,
}: {
  /** Something else owns the microphone, such as a call. */
  disabled: boolean;
  /** The transcript, once, after the recording is transcribed. */
  onWords: (text: string) => void;
}) {
  const { t } = useLingui();
  const router = useRouter();
  const navigation = useNavigation();
  const [status, setStatus] = useState<ComposerDictationStatus>("idle");
  /** When the microphone opened, for the elapsed time beside the waveform. */
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // Read on the UI thread by the waveform, so a level never re-renders the composer.
  const levels = useSharedValue<readonly number[]>(QUIET_LEVELS);
  // The JS side's copy, so a new level never reads the shared value back from the UI thread.
  const levelBuffer = useRef<readonly number[]>(QUIET_LEVELS);
  const session = useRef<Session | null>(null);
  const onWordsRef = useRef(onWords);
  onWordsRef.current = onWords;

  function end(mine: Session) {
    if (session.current !== mine) return false;
    session.current = null;
    setStatus("idle");
    setStartedAt(null);
    return true;
  }

  function pushLevel(decibels: number | undefined) {
    levelBuffer.current = withLevel(levelBuffer.current, decibels);
    levels.value = levelBuffer.current;
  }

  /** The microphone is capturing: the timer starts and finish is enabled. */
  function markListening(mine: Session) {
    if (session.current !== mine) return;
    levelBuffer.current = QUIET_LEVELS;
    levels.value = QUIET_LEVELS;
    setStartedAt(Date.now());
    setStatus("listening");
  }

  /** The microphone is closed. Blur and background must not drop the words still in flight. */
  function markTranscribing(mine: Session) {
    mine.live = false;
    mine.transcribing = true;
    setStatus("transcribing");
  }

  function cancel() {
    const mine = session.current;
    if (!mine) return;
    mine.cancel.abort();
    end(mine);
  }

  useEffect(() => {
    if (disabled) cancel();
  }, [disabled]);
  useEffect(() => cancel, []);
  // A hidden composer must not keep listening: leaving the chat or the app drops the session
  // and its audio.
  useEffect(() => {
    const unsubscribe = navigation.addListener("blur", () => {
      // Leaving the screen while the mic is open still cancels. A clip already being
      // transcribed is kept; unmount is what drops it if the composer goes away.
      if (session.current?.transcribing) return;
      cancel();
    });
    // Android reports a permission prompt as background, so during setup a background move only
    // marks the session; it is dropped unless the app is back in front before the mic opens.
    const appState = AppState.addEventListener("change", (state) => {
      const mine = session.current;
      if (!mine) return;
      if (state === "active") mine.hidden = false;
      else if (state === "background") {
        if (mine.transcribing) return;
        if (mine.live) cancel();
        else mine.hidden = true;
      }
    });
    return () => {
      unsubscribe();
      appState.remove();
    };
  }, [navigation]);

  /** Opens the mic only for a session still current and in front; a hidden one is dropped. */
  async function goLive(mine: Session) {
    // A permission answer can land just before Android reports the app in front again.
    if (mine.hidden) await untilActive(RETURN_FROM_PROMPT_MS);
    if (session.current !== mine) return false;
    if (mine.hidden) {
      cancel();
      return false;
    }
    mine.live = true;
    return true;
  }

  async function start(mine: Session) {
    const lang = recognitionLocaleTag(getActiveUiLocale(), await deviceLanguage());
    if (session.current !== mine) return;
    // As in T3 Code, the phone transcribes whenever it can, whichever voice reads replies: it
    // needs only the microphone and keeps the audio on the phone. Its first use downloads the
    // language's model, which the bar shows as preparing.
    const transcribe = await appleTranscriber(lang);
    if (session.current !== mine) return;
    if (transcribe) {
      if (!(await goLive(mine))) return;
      // Names to listen for load while the person speaks; without them it still transcribes.
      const words = bestEffort(
        "load dictation words",
        rpc("voice/words", undefined, {
          timeoutMs: WORDS_TIMEOUT_MS,
          signal: mine.cancel.signal,
        }),
      );
      const stopped = new AbortController();
      mine.finish = () => {
        stopped.abort();
        markTranscribing(mine);
      };
      const audio = await recordAudio(mine.cancel.signal, stopped.signal, {
        onLevel: (decibels) => pushLevel(decibels),
        onRecording: () => markListening(mine),
        onDevice: true,
      });
      if (!audio) {
        end(mine);
        return;
      }
      try {
        if (session.current !== mine) return;
        markTranscribing(mine);
        mine.finish = () => {};
        const taught = (await words)?.words ?? [];
        if (session.current !== mine) return;
        const text = await transcribe(audio.uri, taught);
        if (end(mine) && text) onWordsRef.current(text);
      } finally {
        deleteQuietly(audio.uri);
      }
      return;
    }
    const plan = await resolveVoiceCallPlan(
      {
        loadDeviceVoiceEnabled,
        // A session dropped meanwhile must not show busy again or prompt for speech.
        dictationAvailable: async () => session.current === mine && dictation.available(),
        loadVoiceStatus: () => rpc("voice/status"),
      },
      "dictation",
    );
    if (session.current !== mine) return;
    if (plan.kind === "settings") {
      end(mine);
      router.push("/voice");
      return;
    }
    if (plan.kind === "dictation") {
      end(mine);
      Alert.alert(
        t`Could not dictate`,
        t`Allow speech recognition in Settings, or connect a voice provider that transcribes.`,
        [
          { text: t`Not now`, style: "cancel" },
          { text: t`Open Voice`, onPress: () => router.push("/voice") },
        ],
      );
      return;
    }
    if (plan.kind === "provider" && plan.transcribe) {
      const requestContext = await captureApiRequestContext();
      if (session.current !== mine) return;
      await ensureVoiceConsent(requestContext);
      if (session.current !== mine) return;
      // Ask for the microphone first: on Android its prompt reads as leaving the app.
      const { AudioModule } = await import("expo-audio");
      if (session.current !== mine) return;
      await AudioModule.requestRecordingPermissionsAsync();
      if (!(await goLive(mine))) return;
      const stopped = new AbortController();
      mine.finish = () => {
        stopped.abort();
        markTranscribing(mine);
      };
      const clip = await recordClip(mine.cancel.signal, stopped.signal, {
        onLevel: (decibels) => pushLevel(decibels),
        onRecording: () => markListening(mine),
      });
      if (session.current !== mine) return;
      // A sign-in to another account meanwhile must not send this audio with the old session.
      if (requestContext.sessionGeneration !== currentSessionGeneration()) {
        end(mine);
        return;
      }
      markTranscribing(mine);
      // The recording is already stopped; a second tap must not throw it away. A stalled
      // request ends at the deadline below.
      mine.finish = () => {};
      const deadline = requestDeadline(
        VOICE_RESPONSE_TIMEOUT_MS,
        t`Could not transcribe that.`,
        mine.cancel.signal,
      );
      let text = "";
      try {
        text = clip ? await transcribeClip(clip, deadline.signal, requestContext) : "";
      } catch (error) {
        // A stall surfaces as the deadline's own message; a cancel stays a cancel.
        throw deadline.signal.aborted && !mine.cancel.signal.aborted
          ? deadline.signal.reason
          : error;
      } finally {
        deadline.dispose();
      }
      if (!end(mine) || requestContext.sessionGeneration !== currentSessionGeneration()) return;
      if (text.trim()) onWordsRef.current(text.trim());
      return;
    }
    if (!(await goLive(mine))) return;
    markListening(mine);
    // A stop tap while the recognizer is still loading lands once it has started.
    let stopRequested = false;
    mine.finish = () => {
      stopRequested = true;
      dictation.finishListening();
    };
    await dictation.listen({
      lang,
      endpointMs: DICTATION_PAUSE_MS,
      signal: mine.cancel.signal,
      onFinal: (text) => {
        if (end(mine)) onWordsRef.current(text);
      },
      // Hearing nothing is not an error; a recognizer that broke is.
      onGiveUp: (reason) => {
        if (end(mine) && reason === "failed") Alert.alert(t`Could not dictate`, t`Try again.`);
      },
    });
    if (stopRequested && session.current === mine) dictation.finishListening();
  }

  function toggle() {
    if (session.current) {
      session.current.finish();
      return;
    }
    if (disabled) return;
    // Until the microphone opens, the bar shows it preparing and only cancel stops it.
    const mine: Session = {
      cancel: new AbortController(),
      finish: () => cancel(),
      live: false,
      transcribing: false,
      hidden: false,
    };
    session.current = mine;
    setStatus("preparing");
    start(mine).catch((error: unknown) => {
      mine.cancel.abort();
      if (!end(mine) || error instanceof AiConsentBlocked) return;
      Alert.alert(t`Could not dictate`, errorText(error, t`Try again.`));
    });
  }

  return { status, startedAt, levels, toggle, cancel };
}
