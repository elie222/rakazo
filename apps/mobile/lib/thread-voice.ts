import { memberName, resolvePersonaColorDef } from "@rakazo/core";
import { useNavigation, useRouter } from "expo-router";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Alert, AppState } from "react-native";
import type { MobileBot, MobileMessage, MobileSnapshot } from "./api";
import { blockText, rpc } from "./api";
import { nextAutoSpeakAction } from "./auto-speak";
import { findSwitchTarget, ringOnArrival, takeRingOnArrival } from "./bot-switch";
import { setCallProviderTranscribe, startCall } from "./call-session";
import { loadDeviceVoiceEnabled } from "./device-voice";
import { available as dictationAvailable } from "./dictation";
import { useI18n } from "./i18n";
import { speakerColorFor } from "./thread-message-text";
import { errorText } from "./user-error";
import { speakQueue, speakText } from "./voice";
import {
  loadCallCallerName,
  probeProviderTranscribe,
  resolveVoiceCallPlan,
} from "./voice-call-entry";

const ATTACHMENT_PLACEHOLDER_LINE = /^\[(?:image|file|chart): .*\]$/;

function speakableMessageText(message: MobileMessage): string {
  return blockText(message)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !ATTACHMENT_PLACEHOLDER_LINE.test(line))
    .join("\n");
}

/**
 * Reads a bot's finished reply aloud when the bot has auto-speak on and its chat is in front.
 * Returns a ref to the latest check, for focus effects that must not re-run on every message.
 */
export function useAutoSpeakReply({
  botId,
  inGroup,
  currentBot,
  snap,
  showingSaved,
}: {
  botId?: string;
  inGroup: boolean;
  currentBot?: MobileBot;
  snap: MobileSnapshot | null;
  showingSaved: boolean;
}) {
  const navigation = useNavigation();
  const autoSpoken = useRef<string | null>(null);
  const autoSpokenBotId = useRef<string | null>(null);

  const speakFinishedReply = useCallback(() => {
    if (!botId || inGroup || !currentBot) return;
    const decision = nextAutoSpeakAction({
      botId: currentBot.id,
      autoSpeak: currentBot.autoSpeak,
      focused: AppState.currentState === "active" && navigation.isFocused(),
      snapshotReady: snap?.botId === currentBot.id && !showingSaved,
      lastSpokenBotId: autoSpokenBotId.current,
      lastSpokenMessageId: autoSpoken.current,
      runStatus: snap?.run?.status,
      messages: snap?.messages ?? [],
    });
    if (decision.action === "seed") {
      autoSpokenBotId.current = currentBot.id;
      autoSpoken.current = decision.messageId;
      return;
    }
    if (decision.action !== "speak") return;
    autoSpokenBotId.current = currentBot.id;
    autoSpoken.current = decision.messageId;
    void speakText(decision.text, {
      botId: currentBot.id,
      speaker: {
        name: currentBot.name,
        color: resolvePersonaColorDef(currentBot.id, currentBot.color).light,
      },
    }).catch(() => undefined);
  }, [
    botId,
    inGroup,
    currentBot,
    navigation,
    showingSaved,
    snap?.botId,
    snap?.messages,
    snap?.run?.status,
  ]);

  const speakFinishedReplyRef = useRef(speakFinishedReply);
  useLayoutEffect(() => {
    speakFinishedReplyRef.current = speakFinishedReply;
  }, [speakFinishedReply]);

  useEffect(() => {
    speakFinishedReply();
    const appState = AppState.addEventListener("change", speakFinishedReply);
    return () => appState.remove();
  }, [speakFinishedReply]);

  return speakFinishedReplyRef;
}

/** Reads the chat aloud from one message on, each bot reply in its speaker's voice. */
export function useSpeakMessages({
  visibleMessages,
  botId,
  members,
  displayName,
  mentionBots,
}: {
  visibleMessages: MobileMessage[];
  botId?: string;
  members: MobileSnapshot["members"] | undefined;
  displayName?: string;
  mentionBots: MobileBot[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  return useCallback(
    (message: MobileMessage) => {
      const startIndex = visibleMessages.findIndex((candidate) => candidate.id === message.id);
      const fromHere = startIndex === -1 ? [message] : visibleMessages.slice(startIndex);
      const items = fromHere.flatMap((candidate) => {
        if (candidate.role !== "bot") return [];
        const text = speakableMessageText(candidate);
        if (!text) return [];
        const speakerBotId = candidate.botId ?? botId ?? members?.[0]?.botId ?? "";
        return [
          {
            text,
            botId: speakerBotId,
            messageId: candidate.id,
            speaker: {
              name: memberName(members, speakerBotId) ?? displayName,
              color: speakerColorFor(mentionBots, members, speakerBotId),
            },
          },
        ];
      });
      if (items.length === 0) return;
      void speakQueue(items)
        .then((spoken) => {
          if (!spoken)
            Alert.alert(t("Could not speak"), t("Add a voice provider in Voice settings."), [
              { text: t("Cancel"), style: "cancel" },
              { text: t("Open Voice"), onPress: () => router.push("/voice") },
            ]);
        })
        .catch((err: unknown) =>
          Alert.alert(t("Could not speak"), errorText(err, t("Try again."))),
        );
    },
    [botId, displayName, mentionBots, members, visibleMessages],
  );
}

/** Starts a voice call with the chat's bot, and answers when another bot's call put the caller through. */
export function useThreadVoiceCall({
  botId,
  readOnly,
  displayName,
  mentionBots,
  mentionBotsRef,
  activeBotId,
}: {
  botId?: string;
  readOnly: boolean;
  displayName?: string;
  mentionBots: MobileBot[];
  /** The newest bot list, read by a call that outlives renders. */
  mentionBotsRef: RefObject<MobileBot[]>;
  /** The bot whose chat is open now. */
  activeBotId: RefObject<string | undefined>;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const voiceCallStarting = useRef(false);

  /** A bot the caller was put through to answers ("Max here. Hi Riley."); a fresh call opens with hello. */
  function callGreeting(botName: string, callerName: string | undefined, switchedHere: boolean) {
    if (switchedHere) {
      return callerName
        ? t("{bot} here. Hi {name}.", { bot: botName, name: callerName })
        : t("{bot} here.", { bot: botName });
    }
    return callerName
      ? t("Hello {name}, {bot} here.", { name: callerName, bot: botName })
      : t("Hello, {bot} here.", { bot: botName });
  }

  /** `switchedHere`: the caller asked another bot to put them through, so this bot answers. */
  async function startVoiceCall(switchedHere = false) {
    if (readOnly) return;
    const targetBotId = botId;
    if (!targetBotId || voiceCallStarting.current) return;
    voiceCallStarting.current = true;
    const loadVoiceStatus = () => rpc("voice/status");
    try {
      const [plan, callerName] = await Promise.all([
        resolveVoiceCallPlan({
          loadDeviceVoiceEnabled,
          dictationAvailable,
          loadVoiceStatus,
        }),
        loadCallCallerName(() => rpc("me")),
      ]);
      if (activeBotId.current !== targetBotId) return;
      if (plan.kind === "settings") {
        router.push("/voice");
        return;
      }
      if (plan.kind === "dictation") {
        Alert.alert(
          t("Calls need transcription"),
          t("Allow speech recognition in Settings, or connect ElevenLabs, OpenAI, or Fish Audio."),
          [
            { text: t("Not now"), style: "cancel" },
            { text: t("Open Voice"), onPress: () => router.push("/voice") },
          ],
        );
        return;
      }
      const botName = displayName ?? t("Bot");
      const startedCallId = startCall({
        botId: targetBotId,
        botName,
        botColor: mentionBots.find((bot) => bot.id === targetBotId)?.color,
        botAvatarSet: mentionBots.find((bot) => bot.id === targetBotId)?.avatarSet,
        transcribe: plan.transcribe,
        greeting: callGreeting(botName, callerName, switchedHere),
        switchBot: (text) => {
          const target = findSwitchTarget(text, mentionBotsRef.current);
          if (!target || target.id === targetBotId) return undefined;
          return { name: target.name, ring: () => openBotChat(target, true) };
        },
      });
      if (plan.kind === "device") {
        void probeProviderTranscribe(loadVoiceStatus)
          .then((enabled) => {
            if (enabled) setCallProviderTranscribe(true, startedCallId);
          })
          .catch(() => undefined);
      }
    } catch {
      if (activeBotId.current === targetBotId) router.push("/voice");
    } finally {
      voiceCallStarting.current = false;
    }
  }

  /** Opens another bot's chat in place of this one, ringing it when the switch came from a call. */
  function openBotChat(target: MobileBot, ring: boolean): void {
    if (ring) ringOnArrival(target.id);
    router.replace({ pathname: "/thread", params: { botId: target.id, name: target.name } });
  }

  useEffect(() => {
    if (botId && takeRingOnArrival(botId)) void startVoiceCall(true);
  }, [botId]);

  return { startVoiceCall, openBotChat };
}
