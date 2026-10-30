import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { PeerConversation } from "@rakazo/core";
import { displayName, loadPeerHistory, peerConversations } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { InlineImageAttachment } from "../components/inline-image-attachment";
import { NativeActionButton } from "../components/native-action-button";
import { SheetCloseButton } from "../components/sheet-close-button";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { openMobileArtifact } from "../lib/artifact-open";
import { useI18n } from "../lib/i18n";
import { isInlineImageBlock } from "../lib/inline-image";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

/** View-only bot-to-bot exchange, opened from a Messaged / Message from chip in a bot's chat. */
export default function PeerChat() {
  const router = useRouter();
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
    botColor?: string;
    peerBotColor?: string;
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
    <View style={[styles.screen, sideInsets]}>
      <Stack.Screen
        options={{
          ...glassHeaderOptions(""),
          headerBackVisible: false,
          headerTitleAlign: "center",
          headerLeft: () => <SheetCloseButton onPress={() => router.back()} />,
          headerTitle: () => (
            <View style={styles.pill}>
              <Text
                numberOfLines={1}
                style={[styles.name, { color: params.botColor ?? tokens.foreground }]}
              >
                {botName}
              </Text>
              <Text style={styles.muted}>⇄</Text>
              <Text
                numberOfLines={1}
                style={[styles.name, { color: params.peerBotColor ?? tokens.foreground }]}
              >
                {peerName}
              </Text>
            </View>
          ),
        }}
      />
      <ScrollView
        ref={scrollRef}
        // Opens at the latest message like a chat; older ones are above.
        onContentSizeChange={() => {
          if (!userScrolled.current) scrollRef.current?.scrollToEnd({ animated: false });
        }}
        onScrollBeginDrag={() => {
          userScrolled.current = true;
        }}
        style={styles.screen}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
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
            const hasInlineImages = item.blocks?.some(isInlineImageBlock);
            const bubbleStyle = [styles.bubble, sent && styles.sentBubble];
            return (
              <View
                key={`${item.messageId}-${index}`}
                style={[
                  styles.message,
                  sent ? styles.sent : styles.received,
                  hasInlineImages ? { gap: 8 } : bubbleStyle,
                ]}
              >
                <View style={hasInlineImages ? bubbleStyle : undefined}>
                  <Text
                    style={[
                      styles.speaker,
                      {
                        color: (sent ? params.botColor : params.peerBotColor) ?? tokens.foreground,
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {sent ? botName : peerName}
                  </Text>
                  <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
                    {item.text}
                  </ChatMarkdown>
                </View>
                {item.blocks?.map((block, index) => {
                  if (block.kind !== "file" && block.kind !== "image") return null;
                  if (isInlineImageBlock(block))
                    return (
                      <InlineImageAttachment
                        key={index}
                        threadTarget={{ botId }}
                        artifactId={block.artifactId}
                        name={block.name}
                        mimeType={block.mimeType}
                        labelColor={tokens.foreground}
                        onOpen={() =>
                          router.push({
                            pathname: "/image",
                            params: {
                              botId,
                              artifactId: block.artifactId,
                              name: block.name,
                              mimeType: block.mimeType,
                            },
                          })
                        }
                      />
                    );
                  return (
                    <View key={index} style={hasInlineImages ? bubbleStyle : undefined}>
                      <NativeActionButton
                        label={block.name}
                        prominence="plain"
                        onPress={() =>
                          void openMobileArtifact(
                            { botId },
                            block.artifactId,
                            block.name,
                            block.mimeType,
                          ).catch((error) =>
                            Alert.alert(
                              t("Could not open file"),
                              errorText(error, t("Try again.")),
                            ),
                          )
                        }
                      />
                    </View>
                  );
                })}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    pill: {
      alignSelf: "center",
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderRadius: 24,
      backgroundColor: tokens.muted,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    name: { ...typeScale.footnote, fontWeight: "600", flexShrink: 1 },
    screen: { flex: 1, backgroundColor: native.page },
    content: { flexGrow: 1, paddingHorizontal: 16, paddingVertical: 16, gap: 10 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
    muted: { color: tokens.mutedForeground, ...typeScale.body, textAlign: "center" },
    retry: { color: tokens.link, ...typeScale.body },
    message: { maxWidth: "85%" },
    bubble: {
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingVertical: 9,
      backgroundColor: tokens.muted,
    },
    sent: { alignSelf: "flex-end" },
    received: { alignSelf: "flex-start" },
    sentBubble: { backgroundColor: tokens.accent },
    speaker: { color: tokens.mutedForeground, ...typeScale.footnote, marginBottom: 4 },
  });
}
