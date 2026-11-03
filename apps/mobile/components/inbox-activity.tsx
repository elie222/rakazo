import type { RunActivityRow } from "@rakazo/contracts";
import { useRouter } from "expo-router";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { activityPreview, activityStatusLabel, formatActivityRelativeTime } from "../lib/activity";
import type { MobileBot } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { BotAvatar } from "./bot-avatar";
import { createHomeStyles } from "./home-styles";
import { ConversationRow, FALLBACK_COLOR } from "./inbox-rows";

export function ActivitySection({
  activity,
  bots,
}: {
  activity: { active: RunActivityRow[]; recent: RunActivityRow[] };
  bots: MobileBot[];
}) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  const router = useRouter();
  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const openRun = (run: RunActivityRow) => {
    if (run.groupId) {
      router.push({
        pathname: "/group-thread",
        params: { groupId: run.groupId, name: run.groupName ?? t("Group") },
      });
      return;
    }
    router.push({ pathname: "/thread", params: { botId: run.botId, name: run.botName } });
  };

  return (
    <View style={styles.activitySection}>
      {activity.active.length > 0 ? (
        <>
          <Text style={styles.sectionHeading}>{t("Now")}</Text>
          {activity.active.map((run) => (
            <ActivityRow
              key={run.runId}
              run={run}
              bot={botsById.get(run.botId)}
              onPress={() => openRun(run)}
            />
          ))}
        </>
      ) : null}
      {activity.recent.length > 0 ? (
        <>
          <Text style={[styles.sectionHeading, activity.active.length > 0 && styles.activityGap]}>
            {t("Recent")}
          </Text>
          {activity.recent.map((run) => (
            <ActivityRow
              key={run.runId}
              run={run}
              bot={botsById.get(run.botId)}
              onPress={() => openRun(run)}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}

function ActivityRow({
  run,
  bot,
  onPress,
}: {
  run: RunActivityRow;
  bot?: MobileBot;
  onPress: () => void;
}) {
  const status = activityStatusLabel(run.status);
  const snippet = activityPreview(run);
  const preview = snippet ? `${status}: ${snippet}` : status;
  // Compact rows hide tags, so the group stays in the title.
  const title = [run.botName, run.groupName].filter(Boolean).join(", ");
  return (
    <ConversationRow
      title={title}
      preview={preview}
      time={formatActivityRelativeTime(run.updatedAt)}
      accessibilityLabel={`${title}, ${status}`}
      onPress={onPress}
      avatar={
        <BotAvatar
          identity={run.botId}
          color={bot?.color ?? FALLBACK_COLOR}
          avatarSet={bot?.avatarSet}
          status={run.status}
          motion="lazy"
        />
      }
    />
  );
}
