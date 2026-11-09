/**
 * Full-screen voice chat: the microphone listens continuously, like a voice
 * assistant — tap it to stop listening, hold below to talk for one turn.
 * The orb breathes with the conversation; the transcript lists what was
 * heard and what the bot said, with the reply's action row underneath.
 */

import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassIconButton } from "../components/glass-icon-button";
import { GlassSurface } from "../components/glass-surface";
import { NativeSymbol } from "../components/native-symbol";
import { Checkmark } from "../components/row-accessories";
import { MessageActionRow } from "../components/thread/message-row";
import { VoiceChatOrb } from "../components/voice-chat-orb";
import { useI18n } from "../lib/i18n";
import { shareMessageText } from "../lib/message-context-menu";
import { useMobileTokens } from "../lib/native";
import { favoriteSnippet, toggleThreadFavorite, useThreadFavorites } from "../lib/thread-favorites";
import type { VoiceChatPhase } from "../lib/voice-chat";
import {
  createVoiceChatSession,
  productionVoiceChatDeps,
  voiceChatOrbVariant,
} from "../lib/voice-chat";
import { VOICE_CHAT_SCENARIOS, voiceChatScenario } from "../lib/voice-chat-scenarios";

function statusText(phase: VoiceChatPhase, notice: string | null, t: (text: string) => string) {
  if (phase === "not-ready") return notice ?? t("Voice chat isn't ready yet.");
  if (phase === "listening") return t("Listening...");
  if (phase === "thinking") return t("Thinking...");
  if (phase === "speaking") return t("AI is replying...");
  return t("Hold to talk");
}

export default function VoiceChatScreen() {
  const params = useLocalSearchParams<{ botId?: string; name?: string }>();
  const botId = params.botId ?? "";
  const router = useRouter();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const botName = params.name || t("Bot");
  const [session] = useState(() => createVoiceChatSession(productionVoiceChatDeps()));
  const [state, setState] = useState(session.getState());
  const [pickerOpen, setPickerOpen] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => session.subscribe(() => setState(session.getState())), [session]);

  useEffect(() => {
    if (!botId) {
      router.back();
      return;
    }
    session.start(botId, botName);
    // Listening starts with the screen: the caller talks whenever they want,
    // and the microphone reopens after each reply.
    session.setHandsFree(true);
    return () => session.end();
  }, [botId, botName, router, session]);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: !reducedMotion });
  }, [state.exchanges.length, state.heard, reducedMotion]);

  const hangUp = () => {
    session.end();
    router.back();
  };

  const variant = voiceChatOrbVariant(state.phase, state.heard);
  const scenario = voiceChatScenario(state.scenarioId);
  const lastBot = [...state.exchanges].reverse().find((exchange) => exchange.role === "bot");
  const favorites = useThreadFavorites(botId ?? "");
  const lastBotFavorited = lastBot?.messageId
    ? favorites.some((item) => item.messageId === lastBot.messageId)
    : false;
  const favoriteLastBot = () => {
    if (!botId || !lastBot?.messageId) return;
    toggleThreadFavorite(botId, {
      messageId: lastBot.messageId,
      snippet: favoriteSnippet(lastBot.text),
      createdAt: Date.now(),
    });
  };

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: tokens.background,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Choose a scenario")}
        onPress={() => setPickerOpen(true)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 20 }}
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 15 }}>
          {t("Choose a scenario")}
        </Text>
        <Text style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}>
          {t(scenario.titleKey)}
        </Text>
        <NativeSymbol
          ios="chevron.down"
          android="chevron-down-outline"
          size={14}
          color={tokens.mutedForeground}
        />
      </Pressable>

      <View style={{ alignItems: "center", paddingTop: 28 }}>
        <VoiceChatOrb variant={variant} reducedMotion={reducedMotion} />
        <Text
          style={{
            color: state.phase === "not-ready" ? tokens.destructive : tokens.foreground,
            fontSize: 17,
            fontWeight: "600",
            marginTop: 20,
          }}
        >
          {statusText(state.phase, state.notice, t)}
        </Text>
        <Text style={{ color: tokens.mutedForeground, fontSize: 14, marginTop: 4 }}>{botName}</Text>
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1, paddingHorizontal: 20, marginTop: 16 }}
        contentContainerStyle={{ gap: 10, paddingBottom: 12 }}
      >
        {state.exchanges.map((exchange, index) => (
          <View key={`${exchange.role}-${index + 1}`} style={{ alignItems: "flex-start" }}>
            <View
              style={{
                alignSelf: exchange.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "85%",
                borderRadius: 16,
                paddingHorizontal: 14,
                paddingVertical: 10,
                backgroundColor: exchange.role === "user" ? tokens.muted : tokens.card,
                ...(exchange.role === "bot"
                  ? { borderWidth: 1, borderColor: tokens.border }
                  : null),
              }}
            >
              <Text style={{ color: tokens.foreground, fontSize: 16, lineHeight: 22 }}>
                {exchange.text}
              </Text>
            </View>
            {exchange.role === "bot" && exchange === lastBot ? (
              <MessageActionRow
                labels={{
                  copy: t("Copy"),
                  speak: t("Speak message"),
                  favorite: lastBotFavorited ? t("Unfavorite") : t("Favorite"),
                  share: t("Share"),
                  regenerate: t("Regenerate"),
                }}
                onCopy={() => {
                  void Clipboard.setStringAsync(exchange.text).catch(() => undefined);
                }}
                onSpeak={() => session.speakLastReply()}
                canSpeak
                speaking={state.phase === "speaking"}
                reducedMotion={reducedMotion}
                onShare={() => shareMessageText(exchange.text)}
                onFavorite={lastBot?.messageId ? favoriteLastBot : undefined}
                favorited={lastBotFavorited}
                onRegenerate={() => session.resendLastUserTurn()}
              />
            ) : null}
          </View>
        ))}
        {state.phase === "listening" && state.heard ? (
          <View
            style={{
              alignSelf: "flex-end",
              maxWidth: "85%",
              borderRadius: 16,
              paddingHorizontal: 14,
              paddingVertical: 10,
              backgroundColor: tokens.muted,
              opacity: 0.7,
            }}
          >
            <Text style={{ color: tokens.foreground, fontSize: 16, lineHeight: 22 }}>
              {state.heard}
            </Text>
          </View>
        ) : null}
        {state.phase === "not-ready" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Open Voice")}
            onPress={() => router.push("/voice")}
            style={{ alignSelf: "center", marginTop: 8 }}
          >
            <Text style={{ color: tokens.link, fontSize: 15 }}>{t("Open Voice")}</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      <View style={{ paddingHorizontal: 20, paddingBottom: 8 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 20,
          }}
        >
          <GlassSurface
            shape="circle"
            tint={state.phase === "listening" ? tokens.primary : undefined}
            style={{ width: 56, height: 56 }}
            fallbackStyle={{
              borderRadius: 28,
              ...(state.phase === "listening"
                ? { backgroundColor: tokens.primary }
                : { borderWidth: 1, borderColor: tokens.border }),
            }}
          >
            <Pressable
              testID="voice-chat-mic"
              accessibilityRole="button"
              accessibilityLabel={t("Microphone")}
              accessibilityState={{ selected: state.handsFree || state.phase === "listening" }}
              hitSlop={8}
              onPress={() => session.setHandsFree(!state.handsFree)}
              style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
            >
              <NativeSymbol
                ios="mic.fill"
                android="mic-outline"
                size={22}
                color={state.phase === "listening" ? tokens.primaryForeground : tokens.foreground}
              />
            </Pressable>
          </GlassSurface>
          <GlassIconButton
            accessibilityLabel={t("Keyboard")}
            ios="keyboard"
            android="keypad-outline"
            size={56}
            iconSize={22}
            color={tokens.foreground}
            onPress={hangUp}
            fallbackStyle={{ borderWidth: 1, borderColor: tokens.border }}
          />
          <GlassIconButton
            accessibilityLabel={t("Video")}
            ios="video.fill"
            android="videocam-outline"
            size={56}
            iconSize={22}
            color={tokens.foreground}
            disabled
            onPress={() => undefined}
            fallbackStyle={{ borderWidth: 1, borderColor: tokens.border }}
          />
          <GlassIconButton
            accessibilityLabel={t("Hang up")}
            ios="phone.down.fill"
            android="call-outline"
            size={56}
            iconSize={22}
            color={tokens.destructiveForeground}
            tint={tokens.destructiveFill}
            onPress={hangUp}
            fallbackStyle={{ backgroundColor: tokens.destructiveFill }}
          />
        </View>
        <Pressable
          testID="voice-chat-hold"
          accessibilityRole="button"
          accessibilityLabel={t("Hold to talk")}
          hitSlop={8}
          onPressIn={() => session.pressToTalk()}
          onPressOut={() => session.releaseToSend()}
          style={{ alignItems: "center", marginTop: 16, paddingVertical: 10 }}
        >
          <Text style={{ color: tokens.mutedForeground, fontSize: 15 }}>
            {state.phase === "listening" ? t("Release to send") : t("Hold to talk")}
          </Text>
        </Pressable>
      </View>

      <Modal
        visible={pickerOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setPickerOpen(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: tokens.background,
            paddingTop: 12,
            paddingBottom: insets.bottom,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 20,
              paddingBottom: 8,
            }}
          >
            <Text style={{ color: tokens.foreground, fontSize: 17, fontWeight: "600" }}>
              {t("Choose a scenario")}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Close")}
              hitSlop={8}
              onPress={() => setPickerOpen(false)}
            >
              <NativeSymbol ios="xmark" android="close" size={18} color={tokens.foreground} />
            </Pressable>
          </View>
          <ScrollView style={{ paddingHorizontal: 8 }}>
            {VOICE_CHAT_SCENARIOS.map((entry) => (
              <Pressable
                key={entry.id}
                accessibilityRole="button"
                accessibilityState={{ selected: entry.id === state.scenarioId }}
                onPress={() => {
                  session.setScenario(entry.id);
                  setPickerOpen(false);
                }}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14 }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: tokens.foreground, fontSize: 16 }}>
                    {t(entry.titleKey)}
                  </Text>
                  <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
                    {t(entry.descriptionKey)}
                  </Text>
                </View>
                {entry.id === state.scenarioId ? <Checkmark /> : null}
              </Pressable>
            ))}
            <View style={{ height: 1, backgroundColor: tokens.border, marginVertical: 8 }} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Create a virtual companion")}
              onPress={() => {
                setPickerOpen(false);
                Alert.alert(
                  t("Virtual companions are coming soon."),
                  t(
                    "Create a companion with your own personality, voice, and look, then talk with it here. Nothing to set up yet — this is just a preview.",
                  ),
                );
              }}
              style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14 }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: tokens.foreground, fontSize: 16 }}>
                  {t("Create a virtual companion")}
                </Text>
                <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
                  {t("Personality, voice, and look of your own")}
                </Text>
              </View>
              <View
                style={{
                  borderRadius: 999,
                  backgroundColor: tokens.muted,
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                }}
              >
                <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                  {t("Coming soon")}
                </Text>
              </View>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}
