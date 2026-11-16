import { useLingui } from "@lingui/react/macro";
import {
  AiConsentBlocked,
  recognitionLocaleTag,
  requestDeadline,
  VOICE_RESPONSE_TIMEOUT_MS,
} from "@rakazo/core";
import { useNavigation, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, AppState } from "react-native";
import { captureApiRequestContext, rpc } from "./api";
import { recordClip, transcribeClip } from "./call-session";
import { loadDeviceVoiceEnabled } from "./device-voice";
import * as dictation from "./dictation";
import { deviceLanguage, getActiveUiLocale } from "./i18n";
import { currentSessionGeneration } from "./session";
import { errorText } from "./user-error";
import { ensureVoiceConsent } from "./voice";
import { resolveVoiceCallPlan } from "./voice-call-entry";

/** A pause long enough to think in; one this long, or a mic that never hears anything, ends it. */
const DICTATION_PAUSE_MS = 30_000;

export type ComposerDictationStatus = "idle" | "listening" | "transcribing";

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
 * Tap to dictate into the message box, tap again to stop. It takes the same path a call would:
 * the phone's own recognizer when device voice is on, otherwise the connected voice provider.
 */
export function useComposerDictation({
  disabled,
  onWords,
}: {
  /** Something else owns the microphone, such as a call. */
  disabled: boolean;
  /**
   * The words heard so far: called live on-device, and once with `final` after a provider
   * transcribes, so those words are kept even if the box changed while recording.
   */
  onWords: (text: string, final?: boolean) => void;
}) {
  const { t } = useLingui();
  const router = useRouter();
  const navigation = useNavigation();
  const [status, setStatus] = useState<ComposerDictationStatus>("idle");
  const session = useRef<Session | null>(null);
  const onWordsRef = useRef(onWords);
  onWordsRef.current = onWords;

  function end(mine: Session) {
    if (session.current !== mine) return false;
    session.current = null;
    setStatus("idle");
    return true;
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
    const plan = await resolveVoiceCallPlan({
      loadDeviceVoiceEnabled,
      dictationAvailable: dictation.available,
      loadVoiceStatus: () => rpc("voice/status"),
    });
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
      // Ask for the microphone first: on Android its prompt reads as leaving the app.
      const { AudioModule } = await import("expo-audio");
      await AudioModule.requestRecordingPermissionsAsync();
      if (!(await goLive(mine))) return;
      const stopped = new AbortController();
      mine.finish = () => {
        stopped.abort();
        markTranscribing(mine);
      };
      const clip = await recordClip(mine.cancel.signal, stopped.signal);
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
      if (text.trim()) onWordsRef.current(text.trim(), true);
      return;
    }
    const lang = recognitionLocaleTag(getActiveUiLocale(), await deviceLanguage());
    // The plan above already asked for speech recognition, so the microphone is next.
    if (!(await goLive(mine))) return;
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
      onInterim: (text) => {
        if (session.current === mine) onWordsRef.current(text);
      },
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
    // Until the path is chosen, a second tap cancels.
    const mine: Session = {
      cancel: new AbortController(),
      finish: () => cancel(),
      live: false,
      transcribing: false,
      hidden: false,
    };
    session.current = mine;
    setStatus("listening");
    start(mine).catch((error: unknown) => {
      mine.cancel.abort();
      if (!end(mine) || error instanceof AiConsentBlocked) return;
      Alert.alert(t`Could not dictate`, errorText(error, t`Try again.`));
    });
  }

  return { status, toggle, cancel };
}
