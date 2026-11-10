import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ModelQuota } from "@rakazo/contracts";
import { dateLocaleForUi, useUiLocale } from "../lib/i18n";
import { SettingsGroup, SettingsRow } from "./settings-group";

export function ConnectionQuota({
  label,
  quota: currentQuota,
  loading: currentPending,
  onRefresh,
}: {
  label?: string;
  quota: ModelQuota | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const { t } = useLingui();
  const locale = useUiLocale();
  return (
    <SettingsGroup
      label={label ?? t`Quota`}
      footer={
        currentQuota?.observedAt
          ? `${t`Updated`} ${new Date(currentQuota.observedAt).toLocaleString(dateLocaleForUi(locale))}`
          : undefined
      }
    >
      {currentQuota?.status === "stale" ? <SettingsRow title={t`Last known usage`} /> : null}
      {!currentQuota || currentQuota.status === "unavailable" ? (
        <SettingsRow title={currentPending ? t`Loading` : t`Quota unavailable`} />
      ) : null}
      {currentQuota?.windows.map((window) => (
        <SettingsRow
          key={window.id}
          title={
            window.id === "five_hour"
              ? t`Session`
              : window.id === "seven_day"
                ? t`Weekly`
                : window.id === "monthly"
                  ? t`Monthly`
                  : window.id === "primary_window" || window.id === "secondary_window"
                    ? t`Allowance`
                    : window.id
          }
          value={t`${ph({
            remaining: new Intl.NumberFormat(dateLocaleForUi(locale)).format(
              Math.round((100 - window.usedPercent) * 10) / 10,
            ),
          })}% remaining`}
          detail={
            window.resetsAt
              ? `${t`Resets`} ${new Date(window.resetsAt).toLocaleString(dateLocaleForUi(locale))}`
              : undefined
          }
        />
      ))}
      {currentQuota?.status !== "unsupported" ? (
        <SettingsRow title={t`Refresh`} disabled={currentPending} onPress={onRefresh} />
      ) : null}
    </SettingsGroup>
  );
}
