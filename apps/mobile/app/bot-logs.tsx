import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { workLogRow } from "@rakazo/core";
import { useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text } from "react-native";
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
      {error ? (
        <LoadFailure
          message={errorText(error, t`Couldn't load logs.`)}
          onRetry={() => void refetch()}
        />
      ) : null}
      {data?.length ? (
        <SettingsGroup>
          {data.map((entry) => {
            const { title, size, exitCode, running } = workLogRow(entry);
            const extra = exitCode
              ? t`Exit code ${ph({ code: exitCode })}`
              : running
                ? t`Running`
                : size;
            const output = entry.action?.output;
            return (
              <SettingsRow
                key={entry.id}
                title={title}
                detail={
                  extra
                    ? t`${ph({ tool: entry.tool })}, ${ph({ extra })}`
                    : title === entry.tool
                      ? undefined
                      : entry.tool
                }
                value={formatActivityRelativeTime(entry.createdAt)}
                {...(output
                  ? {
                      accessibilityRole: "button" as const,
                      onPress: () => Alert.alert(title, output),
                    }
                  : {})}
              />
            );
          })}
        </SettingsGroup>
      ) : data || !botId ? (
        <Text style={styles.empty}>{t`No activity yet.`}</Text>
      ) : error ? null : (
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
