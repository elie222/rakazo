import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { memberName, resolvePersonaColorDef, speechFromBlocks } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import { useNavigation, useRouter } from "expo-router";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Alert, AppState } from "react-native";
import type { ApiRequestContext } from "../api/api";
import { captureApiRequestContext, rpc, selectedSpaceId } from "../api/api";
import type { MobileBot, MobileMessage, MobileSnapshot } from "../api/mobile-types";
import { currentSessionGeneration } from "../api/session";
import { errorText } from "../api/user-error";
import { findSwitchTarget, ringOnArrival, takeRingOnArrival } from "../calls/bot-switch";
import {
  autoLanguageNeedsTranscription,
  loadCallAutoLanguage,
} from "../calls/call-language-preference";
import {
  getSnapshot as getCallSnapshot,
  setCallProviderTranscribe,
  startCall,
} from "../calls/call-session";
import { loadCallGreetingEnabled } from "../calls/call-sounds";
import {
  loadCallCallerName,
  probeProviderTranscribe,
  resolveVoiceCallPlan,
} from "../calls/voice-call-entry";
import { onShortcutVoiceChat, takeShortcutVoiceChat } from "../calls/voice-chat-intent";
import { nextAutoSpeakAction } from "../voice/auto-speak";
import { loadDeviceVoiceEnabled } from "../voice/device-voice";
import { available as dictationAvailable } from "../voice/dictation";
import { speakQueue, speakText } from "../voice/voice";
import { speakerColorFor } from "./thread-message-text";

function speakableMessageText(message: MobileMessage): string {
  return speechFromBlocks(message.blocks);
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
      // An active call owns the speaker; the gate only seeds while it lasts.
      callActive: getCallSnapshot() !== null,
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
        color: resolvePersonaColorDef(currentBot.id, currentBot.color).hex,
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
  const { t } = useLingui();
  const router = useRouter();
  return useCallback(
    (message: MobileMessage) => {
      // An active call owns the speaker; a manual read must not cut into it.
      if (getCallSnapshot()) return;
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
            Alert.alert(t`Could not speak`, t`Add a voice provider in Voice settings.`, [
              { text: t`Cancel`, style: "cancel" },
              { text: t`Open Voice`, onPress: () => router.push("/voice") },
            ]);
        })
        .catch((err: unknown) => Alert.alert(t`Could not speak`, errorText(err, t`Try again.`)));
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
  const { t } = useLingui();
  const router = useRouter();
  const voiceCallStarting = useRef(false);

  /** A bot the caller was put through to answers ("Max here. Hi Riley."); a fresh call opens with hello. */
  function callGreeting(botName: string, callerName: string | undefined, switchedHere: boolean) {
    if (switchedHere) {
      return callerName
        ? t`${ph({ bot: botName })} here. Hi ${ph({ name: callerName })}.`
        : t`${ph({ bot: botName })} here.`;
    }
    return callerName
      ? t`Hello ${ph({ name: callerName })}, ${ph({ bot: botName })} here.`
      : t`Hello, ${ph({ bot: botName })} here.`;
  }

  /**
   * `switchedHere`: the caller asked another bot to put them through, so this bot answers.
   * `setupSession`: the session the call belongs to. The checks below wait on the server; a
   * sign-in to another account meanwhile must not start this account's call with the new session.
   */
  async function startVoiceCall(switchedHere = false, setupSession = currentSessionGeneration()) {
    if (readOnly) return;
    const targetBotId = botId;
    if (!targetBotId || voiceCallStarting.current) return;
    voiceCallStarting.current = true;
    const loadVoiceStatus = () => rpc("voice/status");
    const spaceId = selectedSpaceId();
    // A late answer must not act on another chat or a newer sign-in.
    const stillHere = () =>
      activeBotId.current === targetBotId &&
      setupSession === currentSessionGeneration() &&
      selectedSpaceId() === spaceId;
    try {
      const autoLanguage = await loadCallAutoLanguage();
      if (!stillHere()) return;
      const [plan, callerName, greet] = await Promise.all([
        resolveVoiceCallPlan({
          autoLanguage,
          loadDeviceVoiceEnabled,
          dictationAvailable,
          loadVoiceStatus,
        }),
        loadCallCallerName(() => rpc("me")),
        loadCallGreetingEnabled().catch(() => true),
      ]);
      if (!stillHere()) return;
      if (plan.kind === "settings") {
        // The call read the selected Space's own voice when it has one, so open that copy.
        const overrides = spaceId
          ? await bestEffort(
              "voice call: read Space overrides",
              captureApiRequestContext(spaceId).then((requestContext) =>
                rpc("spaceSettings/overrides", undefined, { requestContext }),
              ),
            )
          : undefined;
        if (!stillHere()) return;
        router.push(
          overrides?.includes("voice") ? { pathname: "/voice", params: { spaceId } } : "/voice",
        );
        return;
      }
      if (plan.kind === "dictation") {
        Alert.alert(
          t`Calls need transcription`,
          autoLanguage
            ? autoLanguageNeedsTranscription()
            : t`Allow speech recognition in Settings, or connect a voice provider that transcribes.`,
          [
            { text: t`Not now`, style: "cancel" },
            { text: t`Open Voice`, onPress: () => router.push("/voice") },
          ],
        );
        return;
      }
      const botName = displayName ?? t`Bot`;
      // The call keeps the Space it starts in: an organization or Space switch mid-call must
      // not move its turns, speech or hang-up to another Space.
      const requestContext: ApiRequestContext = await captureApiRequestContext(spaceId);
      if (!stillHere()) return;
      const startedCallId = startCall({
        botId: targetBotId,
        botName,
        botColor: mentionBots.find((bot) => bot.id === targetBotId)?.color,
        botAvatarSet: mentionBots.find((bot) => bot.id === targetBotId)?.avatarSet,
        transcribe: plan.transcribe,
        autoLanguage,
        greeting: greet ? callGreeting(botName, callerName, switchedHere) : undefined,
        session: setupSession,
        requestContext,
        switchBot: (text) => {
          const target = findSwitchTarget(text, mentionBotsRef.current);
          if (!target || target.id === targetBotId) return undefined;
          return { name: target.name, ring: () => openBotChat(target, true) };
        },
      });
      if (!startedCallId) return;
      if (plan.kind === "device" && !autoLanguage) {
        void probeProviderTranscribe(loadVoiceStatus)
          .then((enabled) => {
            if (enabled) setCallProviderTranscribe(true, startedCallId);
          })
          .catch(() => undefined);
      }
    } catch (err) {
      // A failed check is not missing setup: show why instead of opening Voice settings.
      if (stillHere()) {
        Alert.alert(t`Could not start the call`, errorText(err, t`Try again.`));
      }
    } finally {
      voiceCallStarting.current = false;
    }
  }

  /** Opens another bot's chat in place of this one, ringing it when the switch came from a call. */
  function openBotChat(target: MobileBot, ring: boolean): void {
    if (ring) ringOnArrival(target.id, currentSessionGeneration());
    router.replace({ pathname: "/thread", params: { botId: target.id, name: target.name } });
  }

  // The shortcut can arrive long after this chat opened, e.g. once an archived chat is restored.
  const startVoiceCallRef = useRef(startVoiceCall);
  useLayoutEffect(() => {
    startVoiceCallRef.current = startVoiceCall;
  });

  // A read-only chat leaves the request waiting until it is restored.
  useEffect(() => {
    if (!botId || readOnly) return;
    const unsubscribe = onShortcutVoiceChat(() => {
      if (takeShortcutVoiceChat(botId)) void startVoiceCallRef.current();
    });
    const session = currentSessionGeneration();
    if (takeRingOnArrival(botId, session)) {
      void startVoiceCall(true, session);
    } else if (takeShortcutVoiceChat(botId)) {
      void startVoiceCall(false, session);
    }
    return unsubscribe;
  }, [botId, readOnly]);

  return { startVoiceCall, openBotChat };
}
