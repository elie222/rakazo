import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { PeerConversation } from "@rakazo/core";
import { displayName, loadPeerHistory, newestPageCards, peerConversations } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import type { DataTag, QueryKey } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useRef } from "react";
import type { ScrollViewInstance } from "react-native";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { InlineImageAttachment } from "../components/media/inline-image-attachment";
import { glassHeaderOptions } from "../components/native/glass-title";
import { NativeActionButton } from "../components/native/native-action-button";
import { SheetCloseButton } from "../components/native/sheet-close-button";
import { errorText } from "../lib/api/user-error";
import { mobileTokens } from "../lib/appearance/appearance";
import { openMobileArtifact } from "../lib/artifacts/artifact-open";
import { useSideInsets } from "../lib/layout/side-insets";
import { isInlineImageBlock } from "../lib/messages/inline-image";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native/native";
import { NewestPageCards, PageCard } from "../lib/pages/page-card";
import { useChatOnScreen } from "../lib/pages/page-card-detail";
import { queryClient, rpcQuery } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

/** View-only bot-to-bot exchange, opened from a Messaged / Message from chip in a bot's chat. */
export default function PeerChat() {
  useChatOnScreen();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const { t } = useLingui();
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
  const botName = displayName(params.botName, t`Bot`);
  const pageRead = (before?: number) =>
    rpcQuery("threads/messages", { botId, before, includePeerRuns: true });
  const historyRead = {
    queryKey: [...pageRead().queryKey, "peer", peerBotId] as unknown as DataTag<
      QueryKey,
      PeerConversation | null,
      Error
    >,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const messages = await loadPeerHistory({
        signal,
        // Each page is its own request, cancelled with the page: a retry never joins one given up.
        loadPage: async (before, pageSignal) => {
          const page = pageRead(before);
          return await page.queryFn({
            client: queryClient,
            queryKey: page.queryKey,
            signal: pageSignal,
            meta: undefined,
          });
        },
      });
      const sources = messages.map((message) => ({
        ...message,
        createdAt: message.createdAt ?? "",
      }));
      return peerConversations(sources).find((entry) => entry.peerBotId === peerBotId) ?? null;
    },
    gcTime: 0,
  };
  const history = useScreenQuery(historyRead, { enabled: Boolean(botId && peerBotId) });
  const { refetch } = history;
  const retry = () => void refetch();
  const state:
    | { kind: "loading" }
    | { kind: "failed" }
    | { kind: "ready"; chat: PeerConversation | null } =
    // A failed re-read keeps the chat already on screen.
    history.data !== undefined
      ? { kind: "ready", chat: history.data }
      : history.isError && !history.isFetching
        ? { kind: "failed" }
        : { kind: "loading" };
  const scrollRef = useRef<ScrollViewInstance>(null);
  const userScrolled = useRef(false);

  const chat = state.kind === "ready" ? state.chat : null;
  const newestPages = newestPageCards(
    (chat?.messages ?? []).map((message) => ({
      id: message.messageId,
      blocks: message.blocks ?? [],
    })),
  );
  const peerName = displayName(chat?.peerBotName ?? params.peerBotName, t`Bot`);
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
            <Text style={styles.muted}>{t`Could not load this chat.`}</Text>
            <Pressable accessibilityRole="button" onPress={retry} hitSlop={8}>
              <Text style={styles.retry}>{t`Try again`}</Text>
            </Pressable>
          </View>
        ) : !chat?.messages.length ? (
          <View style={styles.center}>
            <Text style={styles.muted}>{t`No messages yet`}</Text>
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
                  item.blocks?.some((block) => block.kind === "page") && { width: "85%" },
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
                  if (block.kind === "page")
                    return (
                      <NewestPageCards.Provider key={index} value={newestPages}>
                        <PageCard block={block} messageId={item.messageId} />
                      </NewestPageCards.Provider>
                    );
                  if (block.kind === "chart")
                    return <Text key={index} style={styles.muted}>{`[chart: ${block.name}]`}</Text>;
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
                            Alert.alert(t`Could not open file`, errorText(error, t`Try again.`)),
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
