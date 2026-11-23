import { useLingui } from "@lingui/react/macro";
import { transcriptTime } from "@rakazo/i18n/meeting";
import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Alert, FlatList, StyleSheet, Text, View } from "react-native";
import { SettingsGroup, SettingsRow } from "../components/settings/settings-group";
import { useSpaceChanges } from "../lib/api/roster-signals";
import { errorText } from "../lib/api/user-error";
import { mobileTokens } from "../lib/appearance/appearance";
import { useSideInsets } from "../lib/layout/side-insets";
import { native, useThemedStyles } from "../lib/native/native";
import { useScreenHeader } from "../lib/navigation/screen-header";
import { formRead, queryClient, rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

export default function MeetingTranscriptScreen() {
  const { t } = useLingui();
  const router = useRouter();
  const { botId = "", id = "" } = useLocalSearchParams<{ botId?: string; id?: string }>();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const read = formRead(rpcQuery("meetings/transcript", { id }));
  const list = rpcQuery("meetings/list", { botId });
  const transcript = useScreenQuery(read, { enabled: Boolean(id) });
  const focused = useIsFocused();
  useSpaceChanges(
    "meetings",
    () => transcript.refetch({ cancelRefetch: false }),
    focused && Boolean(id),
  );

  const sharing = useSave({
    save: (_, send) => send("meetings/shareTranscript", { id }),
    stale: [read.queryKey],
  });
  const removal = useSave({
    save: (_, send) => send("meetings/deleteTranscript", { id }),
    stale: [list.queryKey],
    onSaved: () => {
      queryClient.removeQueries({ queryKey: read.queryKey });
      router.back();
    },
    closesScreen: true,
  });
  const turns = transcript.error ? undefined : transcript.data?.turns;
  const confirmDelete = () =>
    Alert.alert(t`Delete this transcript?`, t`The transcript will be removed from Rakazo.`, [
      { text: t`Cancel`, style: "cancel" },
      { text: t`Delete transcript`, style: "destructive", onPress: () => removal.run() },
    ]);
  useScreenHeader({
    title: t`Transcript`,
    action: turns
      ? {
          label: t`Delete`,
          prominence: "destructive",
          onPress: confirmDelete,
          busy: removal.pending,
          disabled: sharing.pending,
        }
      : null,
  });
  const error = transcript.error ?? removal.error;
  return (
    <FlatList
      style={[styles.screen, sideInsets]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      data={turns}
      keyExtractor={(turn, index) => `${turn.startMs}:${index}`}
      renderItem={({ item }) => (
        <View style={styles.turn}>
          <View style={styles.byline}>
            <Text style={styles.time}>{transcriptTime(item.startMs)}</Text>
            <Text style={styles.speaker}>{item.speaker}</Text>
          </View>
          <Text selectable style={styles.body}>
            {item.text}
          </Text>
        </View>
      )}
      ListHeaderComponent={
        <View style={styles.actions}>
          {!turns && transcript.isFetching ? (
            <ActivityIndicator accessibilityLabel={t`Loading transcript…`} />
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {errorText(error, t`Could not open the transcript`)}
            </Text>
          ) : null}
        </View>
      }
      ListFooterComponent={
        transcript.data?.artifactAvailable === false ? (
          <View>
            <SettingsGroup>
              <SettingsRow
                title={t`Share transcript with Space`}
                disabled={sharing.pending || removal.pending}
                onPress={() => sharing.run()}
              />
            </SettingsGroup>
            {sharing.error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {errorText(sharing.error, t`Could not share transcript`)}
              </Text>
            ) : null}
          </View>
        ) : undefined
      }
    />
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 16, gap: 12 },
    turn: { gap: 5, paddingVertical: 6 },
    actions: { gap: 10, marginBottom: 12 },
    byline: { flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: 8 },
    time: { color: native.secondaryLabel, fontVariant: ["tabular-nums"] },
    speaker: { color: native.label, fontWeight: "600" },
    body: { color: native.label, fontSize: 16, lineHeight: 23 },
    error: { color: mobileTokens().destructive },
  });
}
