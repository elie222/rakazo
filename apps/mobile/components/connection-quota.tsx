import type { ModelQuota } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { useI18n } from "../lib/i18n";
import type { SettingsTarget } from "../lib/settings-target";
import { settingsRpc } from "../lib/settings-target";
import { SettingsGroup, SettingsRow } from "./settings-group";

export function ConnectionQuota({
  credentialId,
  target,
  label,
  readOnly = false,
  quotaOverride,
  quotaLoading,
  onRefreshQuota,
}: {
  credentialId: string;
  target: SettingsTarget;
  label?: string;
  readOnly?: boolean;
  quotaOverride?: ModelQuota | null;
  quotaLoading?: boolean;
  onRefreshQuota?: () => void;
}) {
  const { t } = useI18n();
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const [quota, setQuota] = useState<ModelQuota | null>(null);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const hasQuotaOverride = quotaOverride !== undefined;
  useFocusEffect(
    useCallback(() => {
      if (hasQuotaOverride) return;
      let canceled = false;
      const load = async () => {
        setPending(true);
        try {
          const result = await rpc("models/quota", { credentialId });
          if (!canceled) setQuota(result);
        } catch {
          if (!canceled) setQuota((current) => (current ? { ...current, status: "stale" } : null));
        } finally {
          if (!canceled) setPending(false);
        }
      };
      void load();
      const timer = setInterval(() => void load(), 60_000);
      return () => {
        canceled = true;
        clearInterval(timer);
      };
    }, [credentialId, hasQuotaOverride, rpc, refresh]),
  );
  const currentQuota = hasQuotaOverride ? quotaOverride : quota;
  const currentPending = hasQuotaOverride ? (quotaLoading ?? false) : pending;
  if (currentQuota?.status === "unsupported" && !readOnly) return null;
  return (
    <SettingsGroup
      label={label ?? t("Quota")}
      footer={
        currentQuota?.observedAt
          ? `${t("Updated")} ${new Date(currentQuota.observedAt).toLocaleString()}`
          : undefined
      }
    >
      {currentQuota?.status === "stale" ? <SettingsRow title={t("Last known usage")} /> : null}
      {!currentQuota ||
      currentQuota.status === "unavailable" ||
      currentQuota.status === "unsupported" ? (
        <SettingsRow title={currentPending ? t("Loading") : t("Quota unavailable")} />
      ) : null}
      {currentQuota?.windows.map((window) => (
        <SettingsRow
          key={window.id}
          title={
            window.id === "five_hour"
              ? t("Session")
              : window.id === "seven_day"
                ? t("Weekly")
                : window.id === "monthly"
                  ? t("Monthly")
                  : window.id === "primary_window" || window.id === "secondary_window"
                    ? t("Allowance")
                    : window.id
          }
          value={t("{remaining}% remaining", {
            remaining: Math.round((100 - window.usedPercent) * 10) / 10,
          })}
          detail={
            window.resetsAt
              ? `${t("Resets")} ${new Date(window.resetsAt).toLocaleString()}`
              : undefined
          }
        />
      ))}
      <SettingsRow
        title={t("Refresh")}
        disabled={currentPending}
        onPress={hasQuotaOverride ? onRefreshQuota : () => setRefresh((value) => value + 1)}
      />
    </SettingsGroup>
  );
}
