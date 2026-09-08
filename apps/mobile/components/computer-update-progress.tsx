import { COMPUTER_UPDATE_STAGES, type ComputerUpdate } from "@rakazo/contracts";
import { computerUpdateNeedsAttention, computerUpdateStages } from "@rakazo/core";
import { usePathname } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { computerUpdates } from "../lib/computer-updates";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export function ComputerUpdateProgress() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { updates, openId } = useSyncExternalStore(
    computerUpdates.subscribe,
    computerUpdates.getSnapshot,
  );
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const authenticated = !["/sign-in"].includes(pathname);
  useEffect(() => (authenticated ? computerUpdates.watch() : undefined), [authenticated]);
  const labels = [
    t("Getting ready"),
    t("Saving your workspace"),
    t("Recreating the computer"),
    t("Restoring your workspace"),
    t("Reconnecting"),
  ];
  const title = (update: ComputerUpdate) =>
    computerUpdateNeedsAttention(update)
      ? update.action === "recover"
        ? t("Recovery failed")
        : t("Update failed")
      : update.action === "recover"
        ? update.mode === "team"
          ? t("Recovering Team Computer")
          : t("Recovering {name}’s Computer", { name: update.name })
        : update.mode === "team"
          ? t("Updating Team Computer")
          : t("Updating {name}’s Computer", { name: update.name });
  const selected = updates.find((item) => item.id === openId);
  if (!authenticated) return null;
  return (
    <>
      <View pointerEvents="box-none" style={[styles.pills, { top: insets.top + 8 }]}>
        {updates.map((update) => (
          <Pressable
            key={update.id}
            accessibilityRole="button"
            onPress={() => {
              setError(false);
              computerUpdates.open(update.id);
            }}
            style={[styles.pill, { backgroundColor: tokens.card, borderColor: tokens.border }]}
          >
            {!computerUpdateNeedsAttention(update) ? (
              <ActivityIndicator color={tokens.foreground} />
            ) : null}
            <View>
              <Text style={{ color: tokens.foreground }}>{title(update)}</Text>
              <Text style={[styles.secondary, { color: tokens.mutedForeground }]}>
                {labels[COMPUTER_UPDATE_STAGES.indexOf(update.stage)]}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>
      <Modal
        visible={Boolean(selected)}
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={() => computerUpdates.open(null)}
      >
        {selected ? (
          <View style={[styles.sheet, { backgroundColor: tokens.background }]}>
            <Text accessibilityRole="header" style={[styles.title, { color: tokens.foreground }]}>
              {title(selected)}
            </Text>
            {computerUpdateNeedsAttention(selected) ? (
              <Text style={{ color: tokens.mutedForeground }}>
                {selected.status === "interrupted"
                  ? t("Recovery is unavailable until the previous operation has stopped.")
                  : t("Recovery restores the last saved workspace. Unsaved work may be lost.")}
              </Text>
            ) : (
              computerUpdateStages(selected.action).map((stage, index) => {
                const current = computerUpdateStages(selected.action).indexOf(selected.stage);
                return (
                  <View key={stage} style={styles.step}>
                    {index === current ? (
                      <ActivityIndicator color={tokens.foreground} />
                    ) : (
                      <Text style={{ color: tokens.mutedForeground }}>
                        {index < current ? "✓" : "○"}
                      </Text>
                    )}
                    <Text
                      accessibilityLiveRegion={index === current ? "polite" : "none"}
                      style={{
                        color: index === current ? tokens.foreground : tokens.mutedForeground,
                      }}
                    >
                      {labels[COMPUTER_UPDATE_STAGES.indexOf(stage)]}
                    </Text>
                  </View>
                );
              })
            )}
            {error ? (
              <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
                {t("Could not complete action")}
              </Text>
            ) : null}
            {selected.status === "interrupted" && selected.canReleaseReservation ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                style={styles.button}
                onPress={() =>
                  Alert.alert(
                    t("Release interrupted computer?"),
                    t("Make sure nothing is still running on this computer."),
                    [
                      { text: t("Cancel"), style: "cancel" },
                      {
                        text: t("Nothing is still running"),
                        onPress: () => {
                          setBusy(true);
                          setError(false);
                          void computerUpdates
                            .releaseInterrupted(selected.id)
                            .catch(() => setError(true))
                            .finally(() => setBusy(false));
                        },
                      },
                    ],
                  )
                }
              >
                <Text style={{ color: tokens.foreground }}>{t("Release computer")}</Text>
              </Pressable>
            ) : null}
            {selected.status === "failed" ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => {
                  setBusy(true);
                  setError(false);
                  void computerUpdates
                    .start(selected.botId, "recover")
                    .catch(() => setError(true))
                    .finally(() => setBusy(false));
                }}
                style={styles.button}
              >
                <Text style={{ color: tokens.foreground }}>{t("Recover computer")}</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              style={styles.button}
              onPress={() => {
                if (selected.status === "failed")
                  void computerUpdates.dismiss(selected.id).catch(() => setError(true));
                else computerUpdates.open(null);
              }}
            >
              <Text style={{ color: tokens.foreground }}>
                {selected.status === "failed" ? t("Dismiss") : t("Continue in Background")}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </Modal>
    </>
  );
}
const styles = StyleSheet.create({
  pills: { position: "absolute", left: 16, right: 16, zIndex: 100, alignItems: "center", gap: 8 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
  },
  secondary: { fontSize: 12, textAlign: "center", marginTop: 3 },
  sheet: { flex: 1, padding: 24, gap: 24 },
  title: { fontSize: 22, fontWeight: "600" },
  step: { flexDirection: "row", alignItems: "center", gap: 16 },
  button: { minHeight: 44, justifyContent: "center", alignItems: "center" },
});
