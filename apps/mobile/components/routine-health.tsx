import { useQuery } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { rpc } from "../lib/api";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { queryClient, rpcQuery } from "../lib/query";
import { routineHealthLines } from "../lib/routine-health";
import { NativeSwitch } from "./native-switch";

export function RoutineHealth({ routineId }: { routineId: string }) {
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const query = useQuery(
    { ...rpcQuery("routines/health", { routineId }), enabled: false },
    queryClient,
  );
  const { refetch } = query;
  useFocusEffect(
    useCallback(() => {
      void refetch();
      const timer = setInterval(() => void refetch(), 15_000);
      return () => clearInterval(timer);
    }, [refetch]),
  );
  if (query.isError)
    return (
      <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
        {t("Could not load schedule status")}
      </Text>
    );
  if (!query.data) return null;
  const health = query.data;
  async function setAlert(field: "delayed" | "failure", enabled: boolean) {
    setSaving(true);
    setSaveError(false);
    try {
      await rpc("routines/setAlerts", { routineId, [field]: enabled });
      await refetch();
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <View style={{ gap: 8 }}>
      {routineHealthLines(health, dateLocaleForUi(locale)).map((line, index) => (
        <Text key={index} style={{ color: tokens.mutedForeground }}>
          {line}
        </Text>
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: tokens.foreground }}>{t("Delay alerts")}</Text>
        <NativeSwitch
          accessibilityLabel={t("Delay alerts")}
          disabled={saving}
          value={health.delayAlertsEnabled}
          onValueChange={(value) => void setAlert("delayed", value)}
        />
      </View>
      {health.delayAlertsEnabled ? (
        <Text style={{ color: tokens.mutedForeground }}>
          {t("Delay alerts run while the worker is running.")}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: tokens.foreground }}>{t("Failure alerts")}</Text>
        <NativeSwitch
          accessibilityLabel={t("Failure alerts")}
          disabled={saving}
          value={health.failureAlertsEnabled}
          onValueChange={(value) => void setAlert("failure", value)}
        />
      </View>
      {health.delayed && health.delayAlertResult === "failed" ? (
        <Text style={{ color: tokens.destructive }}>{t("Alert could not be sent")}</Text>
      ) : null}
      {health.delayed && health.delayAlertResult === "sent" ? (
        <Text style={{ color: tokens.mutedForeground }}>
          {t("Alert accepted; delivery not confirmed")}
        </Text>
      ) : null}
      {saveError ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {t("Could not save")}
        </Text>
      ) : null}
    </View>
  );
}
