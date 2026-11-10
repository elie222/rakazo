import type { UsageRecord, UsageSummary } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeSegmentedControl } from "../../components/native-segmented-control";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { dateLocaleForUi, useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { useSideInsets } from "../../lib/side-insets";
import {
  compactTokenCount,
  groupUsageModels,
  isFailedUsageRecord,
  last7DaysUsage,
  localDayModelRows,
  localDayTotals,
  usageDetailRecords,
  usageRangeTotals,
  usageRecordTokens,
} from "../../lib/usage-detail";
import { errorText } from "../../lib/user-error";

type UsageRange = "today" | "total";

export default function UsageDetail() {
  const sideInsets = useSideInsets();
  const { t, locale } = useI18n();
  const styles = useThemedStyles(createUsageStyles);
  const [range, setRange] = useState<UsageRange>("today");
  const [totalSummary, setTotalSummary] = useState<UsageSummary | null>(null);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedModel, setExpandedModel] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [total, list] = await Promise.all([rpc("usage/summary"), rpc("usage/list")]);
      setTotalSummary(total);
      setRecords(list);
    } catch (err) {
      setLoadError(errorText(err, t("Could not load usage")));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const count = useMemo(() => new Intl.NumberFormat(dateLocaleForUi(locale)), [locale]);
  const tokens = (value: number | null | undefined) => (value == null ? "—" : count.format(value));
  const today = useMemo(() => new Date(), []);
  // "Today" is the local calendar day, summed from the records themselves —
  // not the rolling 24h window — so it lines up with the detail list.
  const todayTotals = useMemo(() => localDayTotals(records, today), [records, today]);
  const todayModels = useMemo(() => localDayModelRows(records, today), [records, today]);
  const todayRecords = useMemo(() => usageDetailRecords(records, true, today), [records, today]);
  const totalTotals = usageRangeTotals(totalSummary);
  const activeTotals = range === "today" ? todayTotals : totalTotals;
  const activeModels = range === "today" ? todayModels : totalSummary?.models;
  const botNameById = useMemo(
    () => new Map((totalSummary?.bots ?? []).map((bot) => [bot.botId, bot.botName])),
    [totalSummary],
  );
  const trend = useMemo(
    () => last7DaysUsage(totalSummary?.daily, today, t("Today"), records),
    [totalSummary, today, t, records],
  );
  const trendMax = Math.max(1, ...trend.map((day) => day.tokens));
  const models = useMemo(
    () =>
      groupUsageModels(
        activeModels,
        range === "today" ? todayRecords : records,
        activeTotals.totalTokens,
      ),
    [activeModels, todayRecords, records, activeTotals.totalTokens, range],
  );
  const detailRecords = useMemo(
    () => usageDetailRecords(records, range === "today", today),
    [records, range, today],
  );

  const summaryCard = (cardRange: UsageRange, totals: ReturnType<typeof usageRangeTotals>) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: range === cardRange }}
      onPress={() => setRange(cardRange)}
      style={[styles.sumCard, range === cardRange && styles.sumCardSelected]}
    >
      <Text style={styles.sumCap}>
        {cardRange === "today" ? t("Today's usage") : t("Total usage")}
      </Text>
      <Text style={styles.sumBig}>
        {tokens(totals.totalTokens)} <Text style={styles.sumUnit}>{t("tokens")}</Text>
      </Text>
      <Text style={styles.sumSub}>
        {t("{requests} requests", { requests: count.format(totals.runs) })}
        {"\n"}
        {t("Input {input} · Output {output}", {
          input: tokens(totals.inputTokens),
          output: tokens(totals.outputTokens),
        })}
      </Text>
    </Pressable>
  );

  const recordTime = (createdAt: string) => {
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return createdAt;
    const time = date.toLocaleTimeString(dateLocaleForUi(locale), {
      hour: "2-digit",
      minute: "2-digit",
    });
    return date.toDateString() === today.toDateString()
      ? time
      : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
  };

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {loading ? (
          <ActivityIndicator color={native.secondaryLabel} />
        ) : loadError ? (
          <View style={styles.centered}>
            <Text accessibilityRole="alert" style={styles.error}>
              {loadError}
            </Text>
            <Pressable accessibilityRole="button" onPress={() => void load()}>
              <Text style={styles.retry}>{t("Retry")}</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.sumGrid}>
              {summaryCard("today", todayTotals)}
              {summaryCard("total", totalTotals)}
            </View>

            <View style={styles.blockTitle}>
              <Text style={styles.blockHeading}>{t("Last 7 days")}</Text>
              <Text style={styles.blockNote}>{t("tokens")}</Text>
            </View>
            <View style={styles.trend}>
              {trend.length && trend.some((day) => day.tokens > 0) ? (
                <View style={styles.bars}>
                  {trend.map((day) => (
                    <View key={day.date} style={styles.barColumn}>
                      <Text style={styles.barValue}>{compactTokenCount(day.tokens)}</Text>
                      <View
                        style={[
                          styles.bar,
                          {
                            height: `${Math.max(day.tokens > 0 ? 6 : 2, (day.tokens / trendMax) * 100)}%`,
                          },
                          day.isToday && styles.barToday,
                        ]}
                      />
                      <Text style={[styles.barLabel, day.isToday && styles.barLabelToday]}>
                        {day.label}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={styles.empty}>{t("No usage yet")}</Text>
              )}
            </View>

            <View style={styles.blockTitle}>
              <Text style={styles.blockHeading}>{t("By model")}</Text>
              <NativeSegmentedControl
                accessibilityLabel={t("By model")}
                onChange={(value) => setRange(value)}
                options={[
                  { value: "today", label: t("Today") },
                  { value: "total", label: t("Total") },
                ]}
                value={range}
              />
            </View>
            {models.length ? (
              models.map((model) => {
                const open = expandedModel === model.key;
                return (
                  <Pressable
                    key={model.key}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                    onPress={() => setExpandedModel(open ? null : model.key)}
                    style={styles.modelCard}
                  >
                    <View style={styles.modelTop}>
                      <View style={styles.modelText}>
                        <Text style={styles.modelName}>{model.model}</Text>
                        <Text style={styles.modelRole}>
                          {model.role === "voice" ? t("Voice model") : model.provider}
                        </Text>
                      </View>
                      <View style={styles.modelTotal}>
                        <Text style={styles.modelTokens}>{tokens(model.totalTokens)}</Text>
                        <Text style={styles.modelCalls}>
                          {t("tokens")} · {t("{calls} calls", { calls: count.format(model.calls) })}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.shareTrack}>
                      <View
                        style={[
                          styles.shareFill,
                          { width: `${Math.round((model.share ?? 0) * 100)}%` },
                        ]}
                      />
                    </View>
                    <View style={styles.modelSplit}>
                      <Text style={styles.modelSplitText}>
                        {t("Input {input} · Output {output}", {
                          input: tokens(model.inputTokens),
                          output: tokens(model.outputTokens),
                        })}
                      </Text>
                      {model.share !== null ? (
                        <Text style={styles.modelShare}>
                          {t("{percent}% of {range}", {
                            percent: Math.round(model.share * 100),
                            range: range === "today" ? t("Today") : t("Total"),
                          })}
                        </Text>
                      ) : null}
                    </View>
                    {open ? (
                      <View style={styles.modelDetail}>
                        {model.recent.length ? (
                          model.recent.map((recent) => (
                            <View key={recent.id} style={styles.detailRow}>
                              <Text style={styles.detailRowLabel}>{recordTime(recent.label)}</Text>
                              <Text style={styles.detailRowValue}>
                                {recent.failed ? 0 : count.format(recent.tokens)} {t("tokens")}
                              </Text>
                            </View>
                          ))
                        ) : (
                          <Text style={styles.empty}>{t("No usage yet")}</Text>
                        )}
                      </View>
                    ) : (
                      <Text style={styles.expandHint}>
                        {t("Tap a model to see its recent calls")}
                      </Text>
                    )}
                  </Pressable>
                );
              })
            ) : (
              <Text style={styles.empty}>{t("No usage yet")}</Text>
            )}

            <View style={styles.blockTitle}>
              <Text style={styles.blockHeading}>{t("Call details")}</Text>
              <Text style={styles.blockNote}>
                {range === "today" ? `${t("Today")} · ` : ""}
                {t("Latest 100 records")}
              </Text>
            </View>
            <View style={styles.recordsCard}>
              {detailRecords.length ? (
                detailRecords.map((record, index) => {
                  const failed = isFailedUsageRecord(record);
                  const amounts = usageRecordTokens(record);
                  return (
                    <View
                      key={record.id}
                      style={[
                        styles.record,
                        index === detailRecords.length - 1 && styles.recordLast,
                      ]}
                    >
                      <View style={styles.recordMain}>
                        <Text style={styles.recordTitle}>
                          {botNameById.get(record.botId ?? "") ?? record.model}{" "}
                          <Text style={failed ? styles.badgeFail : styles.badgeOk}>
                            {failed ? t("Failed · not counted") : t("Success")}
                          </Text>
                        </Text>
                        <Text style={styles.recordSub}>
                          {recordTime(record.createdAt)} · {record.model}
                          {"\n"}
                          {t("Input {input} · Output {output}", {
                            input: tokens(amounts.input),
                            output: tokens(amounts.output),
                          })}
                        </Text>
                      </View>
                      <View style={styles.recordAmount}>
                        <Text style={[styles.recordTokens, failed && styles.recordTokensFail]}>
                          {failed ? 0 : count.format(amounts.total)}
                        </Text>
                        <Text style={styles.recordUnit}>{t("tokens")}</Text>
                      </View>
                    </View>
                  );
                })
              ) : (
                <Text style={styles.empty}>{t("No usage yet")}</Text>
              )}
            </View>

            <View style={styles.ruleNote}>
              <Text style={styles.ruleText}>
                {t(
                  "Calls are counted from the usage the provider actually returned, input and output separately. Failed calls count as 0 and are not included in the totals.",
                )}
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createUsageStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.groupedPage,
    },
    content: {
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 32,
      gap: 4,
    },
    centered: {
      alignItems: "center",
      gap: 12,
      paddingTop: 32,
    },
    error: {
      color: tokens.destructive,
      fontSize: 15,
      textAlign: "center",
    },
    retry: {
      color: tokens.link,
      fontSize: 16,
      fontWeight: "600",
    },
    empty: {
      color: tokens.mutedForeground,
      fontSize: 14,
      paddingVertical: 12,
      textAlign: "center",
    },
    sumGrid: {
      flexDirection: "row",
      gap: 10,
      marginBottom: 14,
    },
    sumCard: {
      flex: 1,
      backgroundColor: tokens.card,
      borderColor: tokens.border,
      borderRadius: 20,
      borderWidth: 2,
      padding: 14,
    },
    sumCardSelected: {
      backgroundColor: tokens.accent,
      borderColor: tokens.primary,
    },
    sumCap: {
      color: tokens.mutedForeground,
      fontSize: 13,
    },
    sumBig: {
      color: tokens.foreground,
      fontSize: 22,
      fontWeight: "800",
      marginVertical: 5,
    },
    sumUnit: {
      fontSize: 12,
      fontWeight: "600",
      color: tokens.mutedForeground,
    },
    sumSub: {
      color: tokens.mutedForeground,
      fontSize: 12,
      lineHeight: 18,
    },
    blockTitle: {
      flexDirection: "row",
      alignItems: "baseline",
      justifyContent: "space-between",
      marginHorizontal: 4,
      marginTop: 18,
      marginBottom: 10,
    },
    blockHeading: {
      color: tokens.foreground,
      fontSize: 16,
      fontWeight: "700",
    },
    blockNote: {
      color: tokens.faintForeground,
      fontSize: 12,
    },
    trend: {
      backgroundColor: tokens.card,
      borderRadius: 20,
      padding: 16,
    },
    bars: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
      height: 92,
    },
    barColumn: {
      flex: 1,
      alignItems: "center",
      gap: 6,
      height: "100%",
      justifyContent: "flex-end",
    },
    barValue: {
      color: tokens.mutedForeground,
      fontSize: 10,
    },
    bar: {
      width: "100%",
      maxWidth: 30,
      backgroundColor: tokens.mutedForeground,
      borderRadius: 6,
    },
    barToday: {
      backgroundColor: tokens.primary,
    },
    barLabel: {
      color: tokens.faintForeground,
      fontSize: 11,
    },
    barLabelToday: {
      color: tokens.primary,
      fontWeight: "700",
    },
    modelCard: {
      backgroundColor: tokens.card,
      borderRadius: 20,
      padding: 15,
      marginBottom: 10,
    },
    modelTop: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    modelText: {
      flex: 1,
      minWidth: 0,
    },
    modelName: {
      color: tokens.foreground,
      fontSize: 16,
      fontWeight: "700",
    },
    modelRole: {
      color: tokens.faintForeground,
      fontSize: 12,
      marginTop: 2,
    },
    modelTotal: {
      alignItems: "flex-end",
    },
    modelTokens: {
      color: tokens.foreground,
      fontSize: 19,
      fontWeight: "800",
    },
    modelCalls: {
      color: tokens.faintForeground,
      fontSize: 11,
      marginTop: 2,
    },
    shareTrack: {
      height: 7,
      backgroundColor: tokens.muted,
      borderRadius: 99,
      marginVertical: 12,
      overflow: "hidden",
    },
    shareFill: {
      height: "100%",
      backgroundColor: tokens.primary,
      borderRadius: 99,
    },
    modelSplit: {
      flexDirection: "row",
      justifyContent: "space-between",
      gap: 6,
    },
    modelSplitText: {
      color: tokens.mutedForeground,
      fontSize: 12,
    },
    modelShare: {
      color: tokens.foreground,
      fontSize: 12,
      fontWeight: "700",
    },
    modelDetail: {
      borderTopColor: tokens.border,
      borderTopWidth: 1,
      borderStyle: "dashed",
      marginTop: 12,
      paddingTop: 10,
    },
    detailRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingVertical: 3,
    },
    detailRowLabel: {
      color: tokens.mutedForeground,
      fontSize: 12,
    },
    detailRowValue: {
      color: tokens.foreground,
      fontSize: 12,
      fontWeight: "600",
    },
    expandHint: {
      color: tokens.faintForeground,
      fontSize: 11,
      marginTop: 8,
    },
    recordsCard: {
      backgroundColor: tokens.card,
      borderColor: tokens.border,
      borderRadius: 20,
      borderWidth: 1,
      paddingHorizontal: 14,
      paddingVertical: 4,
    },
    record: {
      flexDirection: "row",
      gap: 11,
      paddingVertical: 12,
      borderBottomColor: tokens.border,
      borderBottomWidth: 1,
    },
    recordLast: {
      borderBottomWidth: 0,
    },
    recordMain: {
      flex: 1,
      minWidth: 0,
    },
    recordTitle: {
      color: tokens.foreground,
      fontSize: 14,
      fontWeight: "600",
    },
    badgeOk: {
      color: tokens.success,
      fontSize: 11,
      fontWeight: "700",
    },
    badgeFail: {
      color: tokens.destructive,
      fontSize: 11,
      fontWeight: "700",
    },
    recordSub: {
      color: tokens.faintForeground,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 2,
    },
    recordAmount: {
      alignItems: "flex-end",
    },
    recordTokens: {
      color: tokens.foreground,
      fontSize: 14,
      fontWeight: "700",
    },
    recordTokensFail: {
      color: tokens.destructive,
    },
    recordUnit: {
      color: tokens.faintForeground,
      fontSize: 11,
    },
    ruleNote: {
      backgroundColor: tokens.muted,
      borderRadius: 16,
      marginTop: 16,
      padding: 12,
    },
    ruleText: {
      color: tokens.mutedForeground,
      fontSize: 12,
      lineHeight: 20,
    },
  });
}
