import { t } from "@lingui/core/macro";
import type { CronLabels, CronUnit } from "@rakazo/core";
import { ENGLISH_CRON_LABELS, russianInterval } from "@rakazo/core";

export function cronUnitLabel(unit: CronUnit): string {
  switch (unit) {
    case "minutes":
      return t`minutes`;
    case "hours":
      return t`hours`;
    case "days":
      return t`days`;
    default:
      return unit;
  }
}

export function cronUnitLabelSingular(unit: CronUnit): string {
  switch (unit) {
    case "minutes":
      return t`minute`;
    case "hours":
      return t`hour`;
    case "days":
      return t`day`;
    default:
      return unit;
  }
}

/**
 * Schedule words for `formatCron` outside the editor — routine rows, the
 * composer `@` picker. Member expressions like `preset.n` extract the same
 * "{0}" catalog ids the editor's strings already carry translations for.
 * Russian intervals need case forms, so they share the core helper instead
 * of a catalog string.
 */
export function cronLabels(locale: string): CronLabels {
  if (locale === "en") return ENGLISH_CRON_LABELS;
  return {
    oneTime: t`One-time`,
    everyHour: t`Every hour`,
    cron: t`Cron`,
    everyDay: t`Every day`,
    weekdays: t`Weekdays`,
    weekends: t`Weekends`,
    everyMonday: t`Every Monday`,
    monthly: t`Monthly`,
    weekdayNames: [
      t`Sunday`,
      t`Monday`,
      t`Tuesday`,
      t`Wednesday`,
      t`Thursday`,
      t`Friday`,
      t`Saturday`,
    ],
    interval: (n, unit) => {
      if (locale === "ru") return russianInterval(n, unit);
      const preset = { n };
      const unitLabel = n === 1 ? cronUnitLabelSingular(unit) : cronUnitLabel(unit);
      return { lead: t`Every`, detail: t`${preset.n} ${unitLabel}` };
    },
    atTime: (time) => {
      const preset = { time };
      return t`at ${preset.time}`;
    },
    onThe1stAt: (time) => {
      const preset = { time };
      return t`on the 1st at ${preset.time}`;
    },
    onDayAt: (day, time) => t`on day ${day} at ${time}`,
    hourAtMinute: (minute) => t`Every hour at :${String(minute).padStart(2, "0")}`,
    daySpan: (fromName, toName) => t`${fromName} to ${toName}`,
    everyDays: (names) =>
      names.length === 1
        ? t`Every ${names[0] ?? ""}`
        : t`Every ${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`,
  };
}
