import type { RunActivityRow } from "@rakazo/contracts";
import { notificationAttention } from "@rakazo/core";
import { useRouter } from "expo-router";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { activityPreview, activityStatusLabel, formatActivityRelativeTime } from "../lib/activity";
import type { MobileBot, MobileGroup } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { BotAvatar } from "./bot-avatar";
import { GroupAvatar } from "./group-avatar";
import { createHomeStyles } from "./home-styles";
import { ConversationRow, FALLBACK_COLOR } from "./inbox-rows";

export function ActivitySection({
  activity,
  bots,
  groups = [],
}: {
  activity: { active: RunActivityRow[]; recent: RunActivityRow[] };
  bots: MobileBot[];
  groups?: MobileGroup[];
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

  const runUnread = (run: RunActivityRow) =>
    run.groupId
      ? groups.some((group) => group.id === run.groupId && group.unread)
      : Boolean(botsById.get(run.botId)?.unread);
  const attentionRuns = [...activity.active, ...activity.recent].filter(
    (run) => notificationAttention(run.status, runUnread(run)) === "needs_attention",
  );
  const workingRuns = activity.active.filter(
    (run) => notificationAttention(run.status) === "working",
  );
  const unreadGroups = groups.filter(
    (group) =>
      group.unread && ![...attentionRuns, ...workingRuns].some((run) => run.groupId === group.id),
  );
  const readRecent = activity.recent.filter(
    (run) => !attentionRuns.includes(run) && !runUnread(run),
  );
  return (
    <View style={styles.activitySection}>
      {[
        { title: t("Needs attention"), runs: attentionRuns },
        { title: t("Working"), runs: workingRuns },
      ].map(({ title, runs }) =>
        runs.length ? (
          <View key={title}>
            <Text style={styles.sectionHeading}>{title}</Text>
            {runs.map((run) => (
              <ActivityRow
                key={run.runId}
                run={run}
                bot={botsById.get(run.botId)}
                onPress={() => openRun(run)}
              />
            ))}
          </View>
        ) : null,
      )}
      {unreadGroups.length > 0 ||
      bots.some(
        (bot) =>
          notificationAttention(bot.status, bot.unread, Boolean(bot.runErrorId)) === "unread",
      ) ? (
        <View>
          <Text style={styles.sectionHeading}>{t("Unread")}</Text>
          {unreadGroups.map((group) => (
            <ConversationRow
              key={group.id}
              title={group.name}
              preview={group.preview}
              time=""
              accessibilityLabel={`${group.name}, ${t("Unread")}`}
              onPress={() =>
                router.push({
                  pathname: "/group-thread",
                  params: { groupId: group.id, name: group.name },
                })
              }
              avatar={<GroupAvatar members={group.members} />}
            />
          ))}
          {bots
            .filter(
              (bot) =>
                notificationAttention(bot.status, bot.unread, Boolean(bot.runErrorId)) === "unread",
            )
            .map((bot) => (
              <ConversationRow
                key={bot.id}
                title={bot.name}
                preview={bot.preview}
                time=""
                accessibilityLabel={`${bot.name}, ${t("Unread")}`}
                onPress={() =>
                  router.push({ pathname: "/thread", params: { botId: bot.id, name: bot.name } })
                }
                avatar={
                  <BotAvatar
                    identity={bot.id}
                    color={bot.color}
                    avatarSet={bot.avatarSet}
                    motion="lazy"
                  />
                }
              />
            ))}
        </View>
      ) : null}
      {readRecent.length > 0 ? (
        <>
          <Text style={[styles.sectionHeading, activity.active.length > 0 && styles.activityGap]}>
            {t("Recent")}
          </Text>
          {readRecent.map((run) => (
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
