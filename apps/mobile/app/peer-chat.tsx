import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { PeerConversation } from "@rakazo/core";
import { displayName, loadPeerHistory, peerConversations } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { useSideInsets } from "../lib/side-insets";

/** View-only bot-to-bot exchange, opened from a Messaged / Message from chip in a bot's chat. */
export default function PeerChat() {
  const sideInsets = useSideInsets();
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const params = useLocalSearchParams<{
    botId?: string;
    botName?: string;
    peerBotId?: string;
    peerBotName?: string;
  }>();
  const botId = params.botId ?? "";
  const peerBotId = params.peerBotId ?? "";
  const botName = displayName(params.botName, t("Bot"));
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "failed" } | { kind: "ready"; chat: PeerConversation | null }
  >({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const scrollRef = useRef<ScrollView>(null);
  const userScrolled = useRef(false);

  useEffect(() => {
    if (!botId || !peerBotId) return;
    const abort = new AbortController();
    setState({ kind: "loading" });
    void loadPeerHistory({
      signal: abort.signal,
      loadPage: (before, signal) =>
        rpc("threads/messages", { botId, before, includePeerRuns: true }, { signal }),
    })
      .then((messages) => {
        if (abort.signal.aborted) return;
        const sources = messages.map((message) => ({
          ...message,
          createdAt: message.createdAt ?? "",
        }));
        const chat = peerConversations(sources).find((entry) => entry.peerBotId === peerBotId);
        setState({ kind: "ready", chat: chat ?? null });
      })
      .catch(() => {
        if (!abort.signal.aborted) setState({ kind: "failed" });
      });
    return () => abort.abort();
  }, [botId, peerBotId, attempt]);

  const chat = state.kind === "ready" ? state.chat : null;
  const peerName = displayName(chat?.peerBotName ?? params.peerBotName, t("Bot"));
  return (
    <ScrollView
      ref={scrollRef}
      // Opens at the latest message like a chat; older ones are above.
      onContentSizeChange={() => {
        if (!userScrolled.current) scrollRef.current?.scrollToEnd({ animated: false });
      }}
      onScrollBeginDrag={() => {
        userScrolled.current = true;
      }}
      style={[styles.screen, sideInsets]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={glassHeaderOptions(`${botName}, ${peerName}`)} />
      {state.kind === "loading" ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.mutedForeground} />
        </View>
      ) : state.kind === "failed" ? (
        <View style={styles.center}>
          <Text style={styles.muted}>{t("Could not load this chat.")}</Text>
          <Pressable accessibilityRole="button" onPress={retry} hitSlop={8}>
            <Text style={styles.retry}>{t("Try again")}</Text>
          </Pressable>
        </View>
      ) : !chat?.messages.length ? (
        <View style={styles.center}>
          <Text style={styles.muted}>{t("No messages yet")}</Text>
        </View>
      ) : (
        chat.messages.map((item, index) => {
          const sent = item.direction === "sent";
          return (
            <View
              key={`${item.messageId}-${index}`}
              style={[styles.bubble, sent ? styles.sent : styles.received]}
            >
              <Text style={styles.speaker} numberOfLines={1}>
                {sent ? botName : peerName}
              </Text>
              <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
                {item.text}
              </ChatMarkdown>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { flexGrow: 1, paddingHorizontal: 16, paddingVertical: 16, gap: 10 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
    muted: { color: tokens.mutedForeground, ...typeScale.body, textAlign: "center" },
    retry: { color: tokens.link, ...typeScale.body },
    bubble: { maxWidth: "85%", borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9 },
    sent: { alignSelf: "flex-end", backgroundColor: tokens.accent },
    received: { alignSelf: "flex-start", backgroundColor: tokens.muted },
    speaker: { color: tokens.mutedForeground, ...typeScale.footnote, marginBottom: 4 },
  });
}
