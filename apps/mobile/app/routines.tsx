import type { Routine } from "@rakazo/contracts";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { RoutineList } from "../components/routine-list";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
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

  if (routines?.length) {
    return (
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
    );
  }
  return (
    <View style={[styles.empty, sideInsets]}>
      {routines ? (
        // There is no add button here: routines are set up by asking the bot.
        <Text style={styles.message}>{t("Ask this Bot in chat to set up a routine.")}</Text>
      ) : error ? (
        <>
          <Text style={styles.message}>{t("Could not load routines")}</Text>
          <NativeActionButton
            label={t("Try Again")}
            variant="text"
            prominence="secondary"
            style={styles.retry}
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
    retry: { alignSelf: "center" },
  });
}
