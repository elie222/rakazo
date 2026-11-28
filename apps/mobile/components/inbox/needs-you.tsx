import { useLingui } from "@lingui/react/macro";
import { typeScale } from "@rakazo/ui-tokens";
import type { Href } from "expo-router";
import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { MobileBot } from "../../lib/api/mobile-types";
import { mobileTokens } from "../../lib/appearance/appearance";
import { formatActivityRelativeTime } from "../../lib/inbox/activity";
import type { OpenDecision } from "../../lib/inbox/open-decisions";
import { native, useThemedStyles } from "../../lib/native/native";
import { BotAvatar } from "../bots/bot-avatar";
import { NativeActionButton } from "../native/native-action-button";
import { FALLBACK_COLOR } from "./inbox-rows";

const CARD_WIDTH = 292;

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    heading: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: 8,
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 10,
    },
    title: { color: native.label, ...typeScale.title },
    count: { color: native.secondaryLabel, ...typeScale.body },
    strip: { paddingHorizontal: 16, gap: 10, paddingBottom: 14 },
    card: {
      width: CARD_WIDTH,
      borderRadius: 22,
      borderCurve: "continuous",
      backgroundColor: tokens.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.border,
      paddingHorizontal: 14,
      paddingTop: 14,
      paddingBottom: 12,
      gap: 8,
    },
    who: { flexDirection: "row", alignItems: "center", gap: 8 },
    name: { flex: 1, color: native.secondaryLabel, ...typeScale.caption, fontWeight: "600" },
    time: { color: native.tertiaryLabel, ...typeScale.caption },
    question: { color: native.label, ...typeScale.cardTitle, fontWeight: "600" },
    action: { marginTop: 4 },
  });
}

/** Decisions only you can make, above the chat list. */
export function NeedsYou({
  decisions,
  bots,
  openChat,
}: {
  decisions: readonly OpenDecision[];
  bots: MobileBot[];
  openChat: (href: Href) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { t } = useLingui();
  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  if (decisions.length === 0) return null;
  // Opens the chat at the card that asks.
  const open = ({ run, messageId }: OpenDecision) =>
    openChat(
      run.groupId
        ? {
            pathname: "/group-thread",
            params: { groupId: run.groupId, name: run.groupName ?? t`Group`, messageId },
          }
        : { pathname: "/thread", params: { botId: run.botId, name: run.botName, messageId } },
    );
  return (
    <View>
      <View style={styles.heading} accessibilityRole="header">
        <Text style={styles.title}>{t`Needs you`}</Text>
        <Text style={styles.count}>{decisions.length}</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
        snapToInterval={CARD_WIDTH + 10}
        decelerationRate="fast"
      >
        {decisions.map((decision) => {
          const { run } = decision;
          const bot = botsById.get(run.botId);
          const title = run.groupName ? `${run.botName}, ${run.groupName}` : run.botName;
          return (
            <View key={run.runId} style={styles.card}>
              <View style={styles.who}>
                <BotAvatar
                  color={bot?.color || FALLBACK_COLOR}
                  avatarSet={bot?.avatarSet}
                  identity={run.botId}
                  size={22}
                  motion="static"
                />
                <Text style={styles.name} numberOfLines={1}>
                  {title}
                </Text>
                <Text style={styles.time}>{formatActivityRelativeTime(run.updatedAt)}</Text>
              </View>
              <Text style={styles.question} numberOfLines={2}>
                {decision.text}
              </Text>
              <NativeActionButton
                label={t`Review`}
                accessibilityLabel={`${t`Review`}, ${title}`}
                size="compact"
                style={styles.action}
                onPress={() => open(decision)}
              />
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
