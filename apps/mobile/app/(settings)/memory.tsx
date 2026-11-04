import type { MemoryDocument } from "@rakazo/contracts";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { Chevron } from "../../components/row-accessories";
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

  const load = useCallback(async () => {
    try {
      const docs = await rpc("memory/list", { scope: "user" });
      if (!live.current) return;
      setNotes(docs);
      setError(null);
    } catch (reason) {
      if (live.current) setError(errorText(reason, t("Could not load memory")));
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
    if (live.current) setRefreshing(false);
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
          <View testID="shared-memory" style={styles.list}>
            {notes.map((note) => (
              <Pressable
                key={note.id}
                accessibilityRole="button"
                accessibilityLabel={note.path}
                onPress={() => router.push({ pathname: "/memory-note", params: { id: note.id } })}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <Text numberOfLines={1} style={styles.title}>
                  {note.path}
                </Text>
                <Chevron />
              </Pressable>
            ))}
          </View>
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
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 16, gap: 14 },
    list: { gap: 8 },
    row: {
      minHeight: 52,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 14,
      backgroundColor: native.fill,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    pressed: { backgroundColor: native.fillPressed },
    title: { flex: 1, color: native.label, fontSize: 15 },
    secondary: { color: native.secondaryLabel, fontSize: 15 },
    error: { color: mobileTokens().destructive, fontSize: 13 },
  });
}
