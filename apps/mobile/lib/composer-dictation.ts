import { AiConsentBlocked, recognitionLocaleTag, VOICE_RESPONSE_TIMEOUT_MS } from "@rakazo/core";
import { useNavigation, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, AppState } from "react-native";
import { captureApiRequestContext, rpc } from "./api";
import { recordClip, transcribeClip } from "./call-session";
import { loadDeviceVoiceEnabled } from "./device-voice";
import * as dictation from "./dictation";
import { deviceLanguage, getActiveUiLocale, useI18n } from "./i18n";
import { currentSessionGeneration } from "./session";
import { errorText } from "./user-error";
import { ensureVoiceConsent } from "./voice";
import { resolveVoiceCallPlan } from "./voice-call-entry";

export type ComposerDictationStatus = "idle" | "listening" | "transcribing";

type Session = { cancel: AbortController; finish: () => void };

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
  const { t } = useI18n();
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
  // and its audio. Inactive is left alone, since a permission prompt makes the app inactive.
  useEffect(() => {
    const unsubscribe = navigation.addListener("blur", cancel);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "background") cancel();
    });
    return () => {
      unsubscribe();
      appState.remove();
    };
  }, [navigation]);

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
        t("Could not dictate"),
        t("Allow speech recognition in Settings, or connect a voice provider that transcribes."),
        [
          { text: t("Not now"), style: "cancel" },
          { text: t("Open Voice"), onPress: () => router.push("/voice") },
        ],
      );
      return;
    }
    if (plan.kind === "provider" && plan.transcribe) {
      const requestContext = await captureApiRequestContext();
      await ensureVoiceConsent(requestContext);
      if (session.current !== mine) return;
      const stopped = new AbortController();
      mine.finish = () => {
        stopped.abort();
        setStatus("transcribing");
      };
      const clip = await recordClip(mine.cancel.signal, stopped.signal);
      if (session.current !== mine) return;
      // A sign-in to another account meanwhile must not send this audio with the old session.
      if (requestContext.sessionGeneration !== currentSessionGeneration()) {
        end(mine);
        return;
      }
      setStatus("transcribing");
      // A tap while transcribing gives up on it, and so does a request that stalls.
      mine.finish = cancel;
      const request = new AbortController();
      const forward = () => request.abort();
      mine.cancel.signal.addEventListener("abort", forward, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        request.abort();
      }, VOICE_RESPONSE_TIMEOUT_MS);
      let text = "";
      try {
        text = clip ? await transcribeClip(clip, request.signal, requestContext) : "";
      } catch (error) {
        throw timedOut ? new Error(t("Could not transcribe that.")) : error;
      } finally {
        clearTimeout(timer);
        mine.cancel.signal.removeEventListener("abort", forward);
      }
      if (end(mine) && text.trim()) onWordsRef.current(text.trim(), true);
      return;
    }
    const lang = recognitionLocaleTag(getActiveUiLocale(), await deviceLanguage());
    if (session.current !== mine) return;
    // A stop tap while the recognizer is still loading lands once it has started.
    let stopRequested = false;
    mine.finish = () => {
      stopRequested = true;
      dictation.finishListening();
    };
    await dictation.listen({
      lang,
      endpointMs: null,
      signal: mine.cancel.signal,
      onInterim: (text) => {
        if (session.current === mine) onWordsRef.current(text);
      },
      onFinal: (text) => {
        if (end(mine)) onWordsRef.current(text);
      },
      // Hearing nothing is not an error; a recognizer that broke is.
      onGiveUp: (reason) => {
        if (end(mine) && reason === "failed") Alert.alert(t("Could not dictate"), t("Try again."));
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
    const mine: Session = { cancel: new AbortController(), finish: () => cancel() };
    session.current = mine;
    setStatus("listening");
    start(mine).catch((error: unknown) => {
      mine.cancel.abort();
      if (!end(mine) || error instanceof AiConsentBlocked) return;
      Alert.alert(t("Could not dictate"), errorText(error, t("Try again.")));
    });
  }

  return { status, toggle, cancel };
}
