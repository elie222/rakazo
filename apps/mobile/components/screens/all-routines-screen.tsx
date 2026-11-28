import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ROUTINE_MENTION_BATCH_MAX } from "@rakazo/contracts";
import { useRouter } from "expo-router";
import { useMemo, useSyncExternalStore } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { selectedSpaceId, subscribeSpaceSelection } from "../../lib/api/api";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import { rpcQuery } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { getSearchInbox, subscribeSearchInbox } from "../../lib/search/search-inbox";
import { BotAvatar } from "../bots/bot-avatar";
import { FALLBACK_COLOR } from "../inbox/inbox-rows";
import { NativeActionButton } from "../native/native-action-button";
import { SettingsGroup, SettingsRow } from "../settings/settings-group";

/** Every bot's routines, asked in batches the API accepts, as one read. */
function routinesForBots(botIds: string[]) {
  const batches: string[][] = [];
  for (let start = 0; start < botIds.length; start += ROUTINE_MENTION_BATCH_MAX) {
    batches.push(botIds.slice(start, start + ROUTINE_MENTION_BATCH_MAX));
  }
  const reads = batches.map((ids) => rpcQuery("routines/listForMentions", { botIds: ids }));
  const first = reads[0] ?? rpcQuery("routines/listForMentions", { botIds: [] });
  return {
    queryKey: [...first.queryKey.slice(0, -1), "batches", ...batches],
    queryFn: async (context: Parameters<typeof first.queryFn>[0]) =>
      (await Promise.all(reads.map((read) => read.queryFn(context)))).flat(),
    meta: first.meta,
  };
}

/** The Routines tab: every bot in the Space that runs routines, each opening its own list. */
export default function AllRoutines() {
  const { t } = useLingui();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const sideInsets = useSideInsets();
  const spaces = useSyncExternalStore(subscribeSearchInbox, getSearchInbox);
  // Space selection can change without the search inbox republishing, so follow it directly.
  const spaceId = useSyncExternalStore(subscribeSpaceSelection, selectedSpaceId);
  const bots = useMemo(() => {
    const space = spaces.find((candidate) => candidate.id === spaceId) ?? spaces[0];
    return space?.bots ?? [];
  }, [spaces, spaceId]);
  const read = useScreenQuery(routinesForBots(bots.map((bot) => bot.id)), {
    enabled: bots.length > 0,
  });
  const withRoutines = useMemo(() => {
    const counts = new Map(
      (read.data ?? []).map((entry) => [
        entry.botId,
        {
          total: entry.routines.length,
          active: entry.routines.filter((routine) => routine.active).length,
        },
      ]),
    );
    return bots.flatMap((bot) => {
      const count = counts.get(bot.id);
      return count && count.total > 0 ? [{ bot, ...count }] : [];
    });
  }, [bots, read.data]);

  if (withRoutines.length > 0) {
    return (
      <ScrollView
        style={[styles.screen, sideInsets]}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <SettingsGroup>
          {withRoutines.map(({ bot, total, active }) => (
            <SettingsRow
              key={bot.id}
              accessibilityRole="button"
              title={bot.name}
              detail={
                active === total
                  ? t`${plural(total, { one: "# routine", other: "# routines" })}`
                  : t`${plural(total, { one: "# routine", other: "# routines" })}, ${plural(total - active, { one: "# paused", other: "# paused" })}`
              }
              chevron="right"
              leading={
                <BotAvatar
                  color={bot.color || FALLBACK_COLOR}
                  avatarSet={bot.avatarSet}
                  identity={bot.id}
                  size={32}
                  motion="static"
                />
              }
              onPress={() =>
                router.push({
                  pathname: "/bot-routines",
                  params: { botId: bot.id, name: bot.name },
                })
              }
            />
          ))}
        </SettingsGroup>
      </ScrollView>
    );
  }
  return (
    <View style={[styles.empty, sideInsets]}>
      {read.error ? (
        <>
          <Text style={styles.message}>{t`Could not load routines`}</Text>
          <NativeActionButton
            label={t`Try again`}
            variant="text"
            prominence="secondary"
            style={styles.centered}
            onPress={() => void read.refetch()}
          />
        </>
      ) : read.isPending && bots.length > 0 ? (
        <ActivityIndicator color={native.secondaryLabel} />
      ) : (
        <Text style={styles.message}>{t`Ask a bot in chat to set up a routine.`}</Text>
      )}
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 16, gap: 16 },
    empty: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 32,
      gap: 8,
      backgroundColor: native.groupedPage,
    },
    message: { color: native.secondaryLabel, fontSize: 17, textAlign: "center" },
    centered: { alignSelf: "center" },
  });
}
