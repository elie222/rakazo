import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { workLogRow } from "@rakazo/core";
import { useLocalSearchParams } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet, Text } from "react-native";
import { LoadFailure } from "../components/load-failure";
import { SettingsGroup, SettingsRow, useStackedSettings } from "../components/settings-group";
import { formatActivityRelativeTime } from "../lib/activity";
import { native, useThemedStyles } from "../lib/native";
import { rpcQuery } from "../lib/query";
import { useScreenQuery } from "../lib/screen-query";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function BotLogs() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const stacked = useStackedSettings();
  const { botId = "" } = useLocalSearchParams<{ botId?: string }>();
  const { data, error, refetch } = useScreenQuery(rpcQuery("bots/workLog", { botId }), {
    enabled: Boolean(botId),
  });
  return (
    <ScrollView
      style={[styles.screen, sideInsets]}
      contentContainerStyle={[styles.content, stacked && styles.compactContent]}
      contentInsetAdjustmentBehavior="automatic"
    >
      {data?.length ? (
        <SettingsGroup>
          {data.map((entry) => {
            const { title, size, exitCode } = workLogRow(entry);
            return (
              <SettingsRow
                key={entry.id}
                title={title}
                detail={
                  exitCode
                    ? t`${ph({ tool: entry.tool })}, exit code ${ph({ code: exitCode })}`
                    : size
                      ? t`${ph({ tool: entry.tool })}, ${ph({ size })}`
                      : title === entry.tool
                        ? undefined
                        : entry.tool
                }
                value={formatActivityRelativeTime(entry.createdAt)}
              />
            );
          })}
        </SettingsGroup>
      ) : data ? (
        <Text style={styles.empty}>{t`No activity yet.`}</Text>
      ) : error ? (
        <LoadFailure
          message={errorText(error, t`Could not load logs.`)}
          onRetry={() => void refetch()}
        />
      ) : (
        <ActivityIndicator />
      )}
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, gap: 28 },
    compactContent: { paddingHorizontal: 8 },
    empty: { color: native.secondaryLabel, fontSize: 15, textAlign: "center" },
  });
}
