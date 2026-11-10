import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { mobileTokens } from "../../lib/appearance";
import { native, useThemedStyles } from "../../lib/native";
import { queryClient, rpcQuery } from "../../lib/query";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

/** The notes every bot in this space shares. A bot's own notes live in its chat settings. */
export default function MemoryScreen() {
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useLingui();
  const read = rpcQuery("memory/list", { scope: "user" });
  // A refetch replaces one still running, so a slow earlier read cannot bring back a deleted note.
  const { data: notes, error: failure, refetch } = useQuery(read, queryClient);
  const error = failure ? errorText(failure, t`Could not load memory`) : null;
  const [refreshing, setRefreshing] = useState(false);

  // Bots write memory as they run, and a note may have changed in its editor.
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  async function refresh() {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        {!notes && !error ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t`Loading…`} />
        ) : null}
        {notes?.length === 0 ? (
          <Text style={styles.secondary}>{t`Nothing remembered yet`}</Text>
        ) : null}
        {notes?.length ? (
          <SettingsGroup>
            {notes.map((note) => (
              <SettingsRow
                key={note.id}
                accessibilityRole="button"
                chevron="right"
                onPress={() => router.push({ pathname: "/memory-note", params: { id: note.id } })}
                title={note.path}
              />
            ))}
          </SettingsGroup>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {error && !notes ? (
          <NativeActionButton
            fill={false}
            label={t`Retry`}
            // Back to the spinner while it reads again.
            onPress={() => void queryClient.resetQueries({ queryKey: read.queryKey })}
            prominence="secondary"
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 20, gap: 16 },
    secondary: { color: native.secondaryLabel, fontSize: 15 },
    error: { color: mobileTokens().destructive, fontSize: 13 },
  });
}
