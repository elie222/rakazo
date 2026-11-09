import { AiConsentBlocked, recognitionLocaleTag } from "@rakazo/core";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
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
  /** The words heard so far; called live on-device and once after a provider transcribes. */
  onWords: (text: string) => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
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
      const text = clip ? await transcribeClip(clip, mine.cancel.signal, requestContext) : "";
      if (end(mine) && text.trim()) onWordsRef.current(text.trim());
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
