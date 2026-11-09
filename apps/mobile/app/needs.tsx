import type { AttentionItem } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useIsFocused, useRouter } from "expo-router";
import { useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSymbol } from "../components/native-symbol";
import { formatActivityRelativeTime } from "../lib/activity";
import { rpc, selectedSpaceId } from "../lib/api";
import { subscribeConfirmedSpaceSwitch } from "../lib/api-server";
import { mobileTokens } from "../lib/appearance";
import {
  attentionDetail,
  attentionHref,
  attentionIcon,
  attentionSections,
  attentionTitle,
} from "../lib/attention";
import { useForegroundPoll } from "../lib/foreground-poll";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { ATTENTION_POLL_INTERVAL_MS } from "../lib/poll-cadence";
import { queryClient, rpcQuery } from "../lib/query";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function NeedsYouScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const isFocused = useIsFocused();
  const tokens = mobileTokens();
  const styles = useThemedStyles(() => createStyles(tokens));
  const sideInsets = useSideInsets();
  const insets = useSafeAreaInsets();
  // The thread route can switch Spaces under a mounted screen; follow it instead of
  // refetching the Space the screen was first painted in.
  const spaceId = useSyncExternalStore(
    subscribeConfirmedSpaceSwitch,
    selectedSpaceId,
    selectedSpaceId,
  );
  const attentionQuery = rpcQuery("attention/list", undefined, spaceId ?? undefined);
  const query = useQuery(attentionQuery, queryClient);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const items = query.data?.items ?? [];
  const sections = attentionSections(items, t);

  // The first poll run would duplicate the fetch useQuery already made on mount; a later
  // focus re-enables the poll and refreshes at once.
  const polled = useRef(false);
  useForegroundPoll(
    async () => {
      if (!polled.current) {
        polled.current = true;
        return;
      }
      await query.refetch();
    },
    ATTENTION_POLL_INTERVAL_MS,
    isFocused,
  );

  async function answer(item: AttentionItem, actionId: string, answerValue: string) {
    if (!item.runId || !item.messageId || busy) return;
    const key = `${item.id}:${actionId}`;
    setBusy(key);
    try {
      await rpc("threads/answer", {
        ...(item.groupId ? { groupId: item.groupId } : { botId: item.botId }),
        runId: item.runId,
        messageId: item.messageId,
        answer: answerValue,
      });
      await queryClient.invalidateQueries({ queryKey: attentionQuery.queryKey });
    } catch (error) {
      Alert.alert(t("Could not answer this card."), errorText(error, t("Please try again.")));
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await query.refetch();
    } finally {
      setRefreshing(false);
    }
  }

  if (query.isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={tokens.mutedForeground} accessibilityLabel={t("Loading…")} />
      </View>
    );
  }

  if (query.error && !query.data) {
    return (
      <View style={[styles.center, sideInsets]}>
        <Text style={styles.emptyTitle}>{t("Could not load what needs you.")}</Text>
        <NativeActionButton
          label={t("Try again")}
          prominence="secondary"
          onPress={() => void query.refetch()}
        />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, sideInsets, { paddingBottom: insets.bottom + 32 }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          tintColor={tokens.mutedForeground}
          colors={[tokens.mutedForeground]}
          progressBackgroundColor={tokens.muted}
        />
      }
    >
      {query.error ? (
        <Text style={styles.error}>{errorText(query.error, t("Could not refresh."))}</Text>
      ) : null}
      {!items.length ? (
        <View style={styles.center}>
          <NativeSymbol
            ios="checkmark.circle"
            android="checkmark-circle-outline"
            size={30}
            color={tokens.faintForeground}
          />
          <Text style={styles.emptyTitle}>{t("Nothing needs you")}</Text>
        </View>
      ) : (
        sections.map((section) => (
          <View key={section.key} style={styles.section}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            <View style={styles.cards}>
              {section.items.map((item) => {
                const icon = attentionIcon(item);
                return (
                  <View key={item.id} style={styles.card}>
                    <View style={styles.cardTop}>
                      <View style={styles.iconCircle}>
                        <NativeSymbol
                          ios={icon.ios}
                          android={icon.android}
                          size={16}
                          color={tokens.mutedForeground}
                        />
                      </View>
                      <View style={styles.cardBody}>
                        <Text style={styles.title}>{attentionTitle(item, t)}</Text>
                        <Text style={styles.detail} numberOfLines={3}>
                          {attentionDetail(item, t)}
                        </Text>
                      </View>
                      <Text style={styles.time}>{formatActivityRelativeTime(item.createdAt)}</Text>
                    </View>
                    <View style={styles.actions}>
                      {item.actions.map((action) => (
                        <NativeActionButton
                          key={action.id}
                          label={action.label}
                          prominence={
                            action.tone === "danger"
                              ? "destructive"
                              : action.tone === "primary"
                                ? "primary"
                                : "secondary"
                          }
                          fill={false}
                          disabled={busy !== null}
                          busy={busy === `${item.id}:${action.id}`}
                          onPress={() => void answer(item, action.id, action.answer)}
                        />
                      ))}
                      <NativeActionButton
                        label={t("Open chat")}
                        variant="text"
                        prominence="secondary"
                        onPress={() => router.push(attentionHref(item))}
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const createStyles = (tokens: ReturnType<typeof mobileTokens>) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: tokens.background,
    },
    content: {
      paddingHorizontal: 16,
      paddingTop: 16,
      gap: 24,
    },
    section: {
      gap: 8,
    },
    sectionTitle: {
      color: tokens.mutedForeground,
      fontSize: 15,
      lineHeight: 19,
    },
    cards: {
      gap: 8,
    },
    card: {
      backgroundColor: tokens.muted,
      borderRadius: 16,
      gap: 10,
      padding: 14,
    },
    cardTop: {
      alignItems: "flex-start",
      flexDirection: "row",
      gap: 12,
    },
    iconCircle: {
      alignItems: "center",
      backgroundColor: tokens.accent,
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    cardBody: {
      flex: 1,
      gap: 2,
    },
    title: {
      color: tokens.foreground,
      fontSize: 17,
      fontWeight: "500",
      lineHeight: 22,
    },
    detail: {
      color: tokens.mutedForeground,
      fontSize: 15,
      lineHeight: 19,
    },
    time: {
      color: tokens.faintForeground,
      fontSize: 12,
      lineHeight: 16,
    },
    actions: {
      alignItems: "center",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    center: {
      alignItems: "center",
      flex: 1,
      gap: 8,
      justifyContent: "center",
      paddingHorizontal: 24,
      paddingVertical: 64,
    },
    emptyTitle: {
      color: tokens.foreground,
      fontSize: 17,
      fontWeight: "500",
      lineHeight: 22,
      textAlign: "center",
    },
    error: {
      color: tokens.mutedForeground,
      fontSize: 15,
      lineHeight: 19,
    },
  });
