import { useLingui } from "@lingui/react/macro";
import type { TopicSummary } from "@rakazo/contracts";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { SettingsGroup, SettingsRow } from "../components/settings/settings-group";
import { formatActivityRelativeTime } from "../lib/inbox/activity";
import { useMobileTokens } from "../lib/native/native";
import { replyCountLabel, splitTopics, topicRoute, useBotTopics } from "../lib/thread/topics";

/** A bot chat's threads: open ones first, then the ones marked done. */
export default function TopicsScreen() {
  const { botId } = useLocalSearchParams<{ botId?: string }>();
  const router = useRouter();
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const { topics } = useBotTopics(botId);

  if (!botId || !topics) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={tokens.mutedForeground} />
      </View>
    );
  }
  const { open, done } = splitTopics(topics);
  const row = (topic: TopicSummary) => (
    <SettingsRow
      key={topic.id}
      accessibilityRole="button"
      chevron="right"
      title={topic.title}
      detail={topic.replyCount > 0 ? replyCountLabel(topic.replyCount) : undefined}
      value={formatActivityRelativeTime(topic.lastActivityAt)}
      leading={
        <View
          style={[styles.dot, { backgroundColor: topic.unread ? tokens.unread : "transparent" }]}
        />
      }
      onPress={() => router.push(topicRoute(botId, topic.id))}
    />
  );
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic">
      {open.length ? <SettingsGroup>{open.map(row)}</SettingsGroup> : null}
      {done.length ? <SettingsGroup label={t`Done`}>{done.map(row)}</SettingsGroup> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
