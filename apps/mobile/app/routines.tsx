import type { Routine } from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { GlassIconButton } from "../components/glass-icon-button";
import { NativeActionButton } from "../components/native-action-button";
import { RoutineList } from "../components/routine-list";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { deviceTimeZone } from "../lib/routine";
import {
  loadBotRoutines,
  removeBotRoutine,
  setRoutineActive,
  useBotRoutines,
} from "../lib/routine-store";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function Routines() {
  const sideInsets = useSideInsets();
  const { t } = useI18n();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const { botId = "", name } = useLocalSearchParams<{ botId?: string; name?: string }>();
  const { routines, error } = useBotRoutines(botId);
  const [deleting, setDeleting] = useState(false);

  async function remove(routine: Routine) {
    setDeleting(true);
    try {
      await removeBotRoutine(botId, routine.id);
    } catch (cause) {
      Alert.alert(t("Could not delete routine"), errorText(cause, t("Try again.")));
    } finally {
      setDeleting(false);
    }
  }

  function confirmDelete(routine: Routine) {
    if (deleting) return;
    Alert.alert(
      routine.name.trim()
        ? t('Delete "{name}"?', { name: routine.name })
        : t("Delete this routine?"),
      t("This permanently deletes the routine and its run history."),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Delete"), style: "destructive", onPress: () => void remove(routine) },
      ],
    );
  }

  const create = () =>
    router.push({ pathname: "/routine", params: { botId, botName: name, origin: "profile" } });
  const header = (
    <Stack.Screen
      options={
        iosAtLeast(26)
          ? {
              unstable_headerRightItems: () => [
                {
                  type: "button" as const,
                  label: t("New routine"),
                  icon: { type: "sfSymbol" as const, name: "plus" },
                  onPress: create,
                },
              ],
            }
          : {
              headerRight: () => (
                <GlassIconButton
                  accessibilityLabel={t("New routine")}
                  ios="plus"
                  android="add"
                  onPress={create}
                />
              ),
            }
      }
    />
  );

  if (routines?.length) {
    return (
      <>
        {header}
        <RoutineList
          routines={routines}
          timeZone={deviceTimeZone()}
          canDelete={!deleting}
          onOpen={(routine) =>
            router.push({
              pathname: "/routine",
              params: { botId, botName: name, routineId: routine.id, origin: "profile" },
            })
          }
          onToggle={(routine, active) =>
            setRoutineActive(botId, routine, active, (cause) =>
              Alert.alert(t("Could not update routine"), errorText(cause, t("Try again."))),
            )
          }
          onDelete={confirmDelete}
        />
      </>
    );
  }
  return (
    <View style={[styles.empty, sideInsets]}>
      {header}
      {routines ? (
        <>
          <Text style={styles.message}>{t("Ask this Bot in chat to set up a routine.")}</Text>
          <NativeActionButton
            label={t("New routine")}
            variant="text"
            prominence="secondary"
            style={styles.centered}
            onPress={create}
          />
        </>
      ) : error ? (
        <>
          <Text style={styles.message}>{t("Could not load routines")}</Text>
          <NativeActionButton
            label={t("Try again")}
            variant="text"
            prominence="secondary"
            style={styles.centered}
            onPress={() => void loadBotRoutines(botId)}
          />
        </>
      ) : (
        <ActivityIndicator color={native.secondaryLabel} />
      )}
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    empty: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 32,
      gap: 8,
      backgroundColor: native.groupedPage,
    },
    message: { color: native.secondaryLabel, fontSize: 17, textAlign: "center" },
    // The button aligns itself to the start by default.
    centered: { alignSelf: "center" },
  });
}
