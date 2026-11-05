import type { MemoryDocument } from "@rakazo/contracts";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

/** The notes every bot in this space shares. A bot's own notes live in its chat settings. */
export default function MemoryScreen() {
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  const [notes, setNotes] = useState<MemoryDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const live = useRef(true);
  // Only the newest load may land, so a slow earlier one cannot bring back a deleted note.
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const order = ++latestLoad.current;
    const current = () => live.current && order === latestLoad.current;
    try {
      const docs = await rpc("memory/list", { scope: "user" });
      if (!current()) return;
      setNotes(docs);
      setError(null);
    } catch (reason) {
      if (current()) setError(errorText(reason, t("Could not load memory")));
    }
  }, [t]);

  // Bots write memory as they run, and a note may have changed in its editor.
  useFocusEffect(
    useCallback(() => {
      live.current = true;
      void load();
      return () => {
        live.current = false;
      };
    }, [load]),
  );

  async function refresh() {
    setRefreshing(true);
    await load();
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
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t("Loading…")} />
        ) : null}
        {notes?.length === 0 ? (
          <Text style={styles.secondary}>{t("Nothing remembered yet")}</Text>
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
            label={t("Retry")}
            onPress={() => {
              setError(null);
              void load();
            }}
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
