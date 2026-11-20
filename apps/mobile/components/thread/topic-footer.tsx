import { useLingui } from "@lingui/react/macro";
import type { TopicSummary } from "@rakazo/contracts";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { formatActivityRelativeTime } from "../../lib/inbox/activity";
import { useMobileTokens } from "../../lib/native/native";
import { replyCountLabel } from "../../lib/thread/topics";

/** The line under a message that has replies in its topic; opens the topic. */
export function TopicFooter({ topic, onPress }: { topic: TopicSummary; onPress: () => void }) {
  const tokens = useMobileTokens();
  const { t } = useLingui();
  const replies = replyCountLabel(topic.replyCount);
  const time = formatActivityRelativeTime(topic.lastActivityAt);
  const muted = [styles.detail, { color: tokens.mutedForeground }];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        topic.unread ? t`Unread` : null,
        replies,
        time,
        topic.settledBy && t`Done`,
      ]
        .filter(Boolean)
        .join(", ")}
      hitSlop={6}
      onPress={onPress}
      style={styles.row}
    >
      {topic.unread ? <View style={[styles.dot, { backgroundColor: tokens.unread }]} /> : null}
      <Text style={[styles.replies, { color: tokens.foreground }]}>{replies}</Text>
      <Text style={muted}>{time}</Text>
      {topic.settledBy ? <Text style={muted}>{t`Done`}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4, paddingVertical: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  replies: { fontSize: 13, fontWeight: "600" },
  detail: { fontSize: 13 },
});
