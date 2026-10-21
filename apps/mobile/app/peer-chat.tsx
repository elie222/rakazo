import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { ThreadMessage } from "@rakazo/contracts";
import {
  formatTimeSeparator,
  loadPeerHistory,
  needsTimeSeparator,
  peerConversations,
} from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/bot-avatar";
import { InlineImageAttachment } from "../components/inline-image-attachment";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSymbol } from "../components/native-symbol";
import { rpc } from "../lib/api";
import { openMobileArtifact } from "../lib/artifact-open";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { isInlineImageMimeType } from "../lib/inline-image";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { errorText } from "../lib/user-error";

export default function PeerChat() {
  const {
    botId,
    botName,
    peerBotId,
    peerBotName: initialName,
    botColor,
    peerBotColor,
  } = useLocalSearchParams<{
    botId: string;
    botName: string;
    peerBotId: string;
    peerBotName: string;
    botColor?: string;
    peerBotColor?: string;
  }>();
  const router = useRouter();
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setStatus("loading");
    setMessages([]);
    void loadPeerHistory({
      signal: abort.signal,
      loadPage: (before, signal) =>
        rpc("threads/messages", { botId, before, includePeerRuns: true }, { signal }),
    })
      .then((loaded) => {
        if (abort.signal.aborted) return;
        setMessages(loaded);
        setStatus("ready");
      })
      .catch(() => {
        if (!abort.signal.aborted) setStatus("error");
      });
    return () => abort.abort();
  }, [botId, retry]);
  const conversation = useMemo(
    () => peerConversations(messages).find((entry) => entry.peerBotId === peerBotId),
    [messages, peerBotId],
  );
  const peerBotName = conversation?.peerBotName ?? initialName;
  const currentColor = botColor ?? tokens.mutedForeground;
  const peerColor = peerBotColor ?? tokens.mutedForeground;
  return (
    <View testID="peer-conversation-view" style={{ flex: 1, backgroundColor: tokens.background }}>
      <Stack.Screen
        options={{
          headerTransparent: true,
          headerShadowVisible: false,
          headerBackVisible: false,
          headerStyle: { backgroundColor: "transparent" },
          headerTitle: () => (
            <View
              accessible
              accessibilityLabel={`${botName}, ${peerBotName}`}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                borderRadius: 999,
                paddingHorizontal: 12,
                paddingVertical: 8,
                backgroundColor: tokens.muted,
                maxWidth: 330,
              }}
            >
              <BotAvatar identity={botId} color={currentColor} size={20} />
              <Text
                numberOfLines={1}
                style={{ color: tokens.foreground, fontSize: 13, fontWeight: "500", flexShrink: 1 }}
              >
                {botName}
              </Text>
              <NativeSymbol
                ios="arrow.left.arrow.right"
                android="swap-horizontal"
                size={14}
                color={tokens.mutedForeground}
              />
              <BotAvatar identity={peerBotId} color={peerColor} size={20} />
              <Text
                numberOfLines={1}
                style={{ color: tokens.foreground, fontSize: 13, fontWeight: "500", flexShrink: 1 }}
              >
                {peerBotName}
              </Text>
            </View>
          ),
          headerTitleAlign: "center",
        }}
      />
      <ScrollView
        testID="peer-conversation-transcript"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: Platform.OS === "android" ? headerHeight + 20 : 20,
          paddingBottom: insets.bottom + 88,
          flexGrow: 1,
        }}
      >
        {status === "loading" ? (
          <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>
            {t("Loading…")}
          </Text>
        ) : status === "error" ? (
          <View style={{ alignItems: "center", gap: 12 }}>
            <Text style={{ color: tokens.mutedForeground }}>{t("Could not load this chat.")}</Text>
            <NativeActionButton
              label={t("Retry now")}
              prominence="secondary"
              onPress={() => setRetry((value) => value + 1)}
            />
          </View>
        ) : !conversation?.messages.length ? (
          <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>
            {t("No messages with {peerBotName} yet.", { peerBotName })}
          </Text>
        ) : (
          conversation.messages.map((message, index) => {
            const sent = message.direction === "sent";
            const color = sent ? currentColor : peerColor;
            return (
              <View key={`${message.messageId}-${index}`} style={{ marginBottom: 12 }}>
                {needsTimeSeparator(
                  message.createdAt,
                  conversation.messages[index - 1]?.createdAt,
                ) ? (
                  <Text
                    style={{
                      textAlign: "center",
                      color: tokens.mutedForeground,
                      fontSize: 12,
                      marginVertical: 12,
                    }}
                  >
                    {formatTimeSeparator(message.createdAt, dateLocaleForUi(locale), {
                      today: t("Today"),
                      yesterday: t("Yesterday"),
                    })}
                  </Text>
                ) : null}
                <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
                  <BotAvatar identity={sent ? botId : peerBotId} color={color} size={20} />
                  <View style={{ maxWidth: "88%", flexShrink: 1 }}>
                    <Text
                      style={{
                        color,
                        fontWeight: "500",
                        fontSize: 12,
                        marginBottom: 4,
                        // Line the name up with the bubble text, not its edge.
                        marginHorizontal: 16,
                      }}
                    >
                      {sent ? botName : peerBotName}
                    </Text>
                    <View
                      style={{
                        backgroundColor: tokens.muted,
                        borderRadius: 20,
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                      }}
                    >
                      <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
                        {message.text}
                      </ChatMarkdown>
                      {message.blocks?.map((block, i) => {
                        if (block.kind !== "image" && block.kind !== "file") return null;
                        const key = `${block.artifactId}-${i}`;
                        if (block.kind === "image" && isInlineImageMimeType(block.mimeType))
                          return (
                            <InlineImageAttachment
                              key={key}
                              labelColor={tokens.foreground}
                              threadTarget={{ botId }}
                              artifactId={block.artifactId}
                              name={block.name}
                              mimeType={block.mimeType}
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
                          <Pressable
                            key={key}
                            accessibilityRole="button"
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
                          >
                            <Text style={{ color: tokens.foreground }}>{block.name}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
      <View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          bottom: insets.bottom + 12,
          left: 0,
          right: 0,
          alignItems: "center",
        }}
      >
        <NativeActionButton
          label={t("Close Chat")}
          prominence="secondary"
          onPress={() => router.back()}
          style={{ borderRadius: 999, minHeight: 44, alignSelf: "center" }}
        />
      </View>
    </View>
  );
}
