import type { AttentionItem } from "@rakazo/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
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
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import {
  attentionDetail,
  attentionHref,
  attentionIcon,
  attentionSections,
  attentionTitle,
} from "../lib/attention";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { rpcQuery } from "../lib/query";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function NeedsYouScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const styles = useThemedStyles(createStyles);
  const sideInsets = useSideInsets();
  const insets = useSafeAreaInsets();
  const tokens = mobileTokens();
  const attentionQuery = rpcQuery("attention/list");
  const query = useQuery(attentionQuery);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const items = query.data?.items ?? [];
  const sections = attentionSections(items, t);

  useFocusEffect(
    useCallback(() => {
      void query.refetch();
    }, [query.refetch]),
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
        <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t("Loading…")} />
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
          tintColor={native.secondaryLabel}
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
            color={native.tertiaryLabel}
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
                          color={native.secondaryLabel}
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

const createStyles = () =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.page,
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
      color: native.secondaryLabel,
      fontSize: 15,
      lineHeight: 19,
    },
    cards: {
      gap: 8,
    },
    card: {
      backgroundColor: native.fill,
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
      backgroundColor: native.fillPressed,
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
      color: native.label,
      fontSize: 17,
      fontWeight: "500",
      lineHeight: 22,
    },
    detail: {
      color: native.secondaryLabel,
      fontSize: 15,
      lineHeight: 19,
    },
    time: {
      color: native.tertiaryLabel,
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
      color: native.label,
      fontSize: 17,
      fontWeight: "500",
      lineHeight: 22,
      textAlign: "center",
    },
    error: {
      color: native.secondaryLabel,
      fontSize: 15,
      lineHeight: 19,
    },
  });
