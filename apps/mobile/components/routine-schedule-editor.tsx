import type { CronFreq, CronPreset, CronUnit } from "@rakazo/core";
import {
  CRON_FREQS,
  clampIntervalAmount,
  cronFromPreset,
  cronIntervalAmounts,
  formatCron,
  localizedClock,
} from "@rakazo/core";
import { cronLabels } from "../lib/cron";
import { useI18n } from "../lib/i18n";
import { MenuPicker } from "./menu-picker";
import { SettingsGroup, SettingsInputRow, SettingsRow } from "./settings-group";

const UNITS: CronUnit[] = ["minutes", "hours", "days"];
const TIMES = [
  "6:00 AM",
  "7:00 AM",
  "8:00 AM",
  "9:00 AM",
  "12:00 PM",
  "3:00 PM",
  "6:00 PM",
  "9:00 PM",
];
const TIMED: CronFreq[] = ["Every day", "Weekdays", "Every week", "Every month"];

/** One schedule of a routine, as native menus; the group's label reads the schedule back. */
export function RoutineScheduleEditor({
  value,
  onChange,
  onRemove,
}: {
  value: CronPreset;
  onChange: (next: CronPreset) => void;
  onRemove: () => void;
}) {
  const { t, locale } = useI18n();
  const labels = cronLabels(locale);
  const freqLabel: Record<CronFreq, string> = {
    "Every hour": t("Every hour"),
    "Every day": t("Every day"),
    Weekdays: t("Weekdays"),
    "Every week": t("Every week"),
    "Every month": t("Every month"),
    Interval: t("Interval"),
    Advanced: t("Advanced"),
  };
  const unitLabel: Record<CronUnit, string> = {
    minutes: t("minutes"),
    hours: t("hours"),
    days: t("days"),
  };
  const times = TIMES.includes(value.time) ? TIMES : [...TIMES, value.time];
  const patch = (partial: Partial<CronPreset>) => onChange({ ...value, ...partial });
  return (
    <SettingsGroup label={formatCron(cronFromPreset(value), labels)}>
      <MenuPicker
        key="freq"
        label={t("How often")}
        value={value.freq}
        choices={CRON_FREQS.map((freq) => ({ key: freq, label: freqLabel[freq] }))}
        onChange={(key) => {
          const freq = key as CronFreq;
          // Advanced starts from the schedule shown, so switching to it changes nothing yet.
          patch(freq === "Advanced" ? { freq, cron: cronFromPreset(value) } : { freq });
        }}
      />
      {value.freq === "Interval" ? (
        <MenuPicker
          key="amount"
          label={t("Every")}
          value={String(value.n)}
          choices={cronIntervalAmounts(value.unit, value.n).map((n) => ({
            key: String(n),
            label: String(n),
          }))}
          onChange={(key) => patch({ n: Number(key) })}
        />
      ) : null}
      {value.freq === "Interval" ? (
        <MenuPicker
          key="unit"
          label={t("Unit")}
          value={value.unit}
          choices={UNITS.map((unit) => ({ key: unit, label: unitLabel[unit] }))}
          onChange={(key) => {
            const unit = key as CronUnit;
            patch({ unit, n: clampIntervalAmount(value.n, unit) });
          }}
        />
      ) : null}
      {TIMED.includes(value.freq) ? (
        <MenuPicker
          key="time"
          label={t("Time of day")}
          value={value.time}
          choices={times.map((time) => ({ key: time, label: localizedClock(time, locale) }))}
          onChange={(time) => patch({ time })}
        />
      ) : null}
      {value.freq === "Advanced" ? (
        <SettingsInputRow
          key="cron"
          accessibilityLabel={t("Cron expression")}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="*/3 * * * *"
          value={value.cron}
          onChangeText={(cron) => patch({ cron })}
        />
      ) : null}
      <SettingsRow
        key="remove"
        accessibilityRole="button"
        destructive
        title={t("Remove schedule")}
        onPress={onRemove}
      />
    </SettingsGroup>
  );
}
