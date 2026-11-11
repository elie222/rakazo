import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ComputerUpdate } from "@rakazo/contracts";
import { COMPUTER_UPDATE_STAGES } from "@rakazo/contracts";
import { computerRestartFailedSaving, computerUpdateNeedsAttention } from "@rakazo/core";
import { usePathname } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { computerUpdates } from "../lib/computer-updates";
import { useMobileTokens } from "../lib/native";
import { GlassSurface } from "./glass-surface";
import { NativeActionButton } from "./native-action-button";
import { NativeSymbol } from "./native-symbol";

export function ComputerUpdateProgress() {
  const { t } = useLingui();
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
    t`Getting ready`,
    t`Saving your workspace`,
    t`Recreating the computer`,
    t`Restoring your workspace`,
    t`Reconnecting`,
  ];
  const title = (update: ComputerUpdate) =>
    computerUpdateNeedsAttention(update)
      ? t`Restart failed`
      : update.mode === "team"
        ? t`Restarting Team Computer`
        : t`Restarting ${ph({ name: update.name })}’s Computer`;
  const selected = updates.find((item) => item.id === openId);
  const restart = (update: ComputerUpdate, discardUnsaved: boolean) => {
    setBusy(true);
    setError(false);
    void computerUpdates
      .start(update.botId, discardUnsaved ? { discardUnsavedAfter: update.id } : {})
      .catch(() => setError(true))
      .finally(() => setBusy(false));
  };
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
          >
            <GlassSurface
              style={styles.pill}
              fallbackStyle={[
                styles.pillFallback,
                { backgroundColor: tokens.glassFill, borderColor: tokens.glassStroke },
              ]}
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
            </GlassSurface>
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
            {selected.status === "interrupted" ? (
              <Text style={{ color: tokens.mutedForeground }}>
                {t`Restart is unavailable until the previous operation has stopped.`}
              </Text>
            ) : selected.status === "failed" ? null : (
              COMPUTER_UPDATE_STAGES.map((stage, index) => {
                const current = COMPUTER_UPDATE_STAGES.indexOf(selected.stage);
                return (
                  <View key={stage} style={styles.step}>
                    {index === current ? (
                      <ActivityIndicator color={tokens.foreground} />
                    ) : (
                      <NativeSymbol
                        ios={index < current ? "checkmark.circle.fill" : "circle"}
                        android={index < current ? "checkmark-circle" : "ellipse-outline"}
                        size={20}
                        color={tokens.mutedForeground}
                      />
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
                {t`Could not complete action`}
              </Text>
            ) : null}
            {selected.status === "failed" ? (
              <NativeActionButton
                label={t`Try again`}
                busy={busy}
                onPress={() => restart(selected, false)}
              />
            ) : null}
            {computerRestartFailedSaving(selected) ? (
              <NativeActionButton
                label={t`Restart without saving`}
                prominence="destructive"
                busy={busy}
                onPress={() =>
                  Alert.alert(
                    t`Restart without saving?`,
                    t`Changes since the last save are lost.`,
                    [
                      { text: t`Cancel`, style: "cancel" },
                      {
                        text: t`Restart without saving`,
                        style: "destructive",
                        onPress: () => restart(selected, true),
                      },
                    ],
                  )
                }
              />
            ) : null}
            <NativeActionButton
              label={selected.status === "failed" ? t`Dismiss` : t`Continue in Background`}
              prominence="secondary"
              fill
              onPress={() => {
                if (selected.status === "failed")
                  void computerUpdates.dismiss(selected.id).catch(() => setError(true));
                else computerUpdates.open(null);
              }}
            />
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
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  pillFallback: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 12 },
  secondary: { fontSize: 12, textAlign: "center", marginTop: 3 },
  sheet: { flex: 1, padding: 24, gap: 24 },
  title: { fontSize: 22, fontWeight: "600" },
  step: { flexDirection: "row", alignItems: "center", gap: 16 },
});
