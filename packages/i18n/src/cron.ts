import { ph, t } from "@lingui/core/macro";
import type { CronLabels, CronUnit } from "@rakazo/core";
import { ENGLISH_CRON_LABELS, localizedClock, polishInterval, russianInterval } from "@rakazo/core";

const SUFFIX_INTERVAL_LOCALES = new Set(["ja", "zh-CN", "zh-TW"]);

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
 * Schedule words for `formatCron` in `locale`: routine rows, the status line, the `@` picker.
 * Polish and Russian intervals need case forms, so they share the core helpers instead of a
 * catalog string.
 */
export function cronLabels(locale: string): CronLabels {
  if (locale === "en") return ENGLISH_CRON_LABELS;
  // zh/ja list days with "、" and read an interval as one suffix phrase ("每5分钟", "5分ごと").
  const suffixInterval = SUFFIX_INTERVAL_LOCALES.has(locale);
  const listSeparator = suffixInterval ? "、" : ", ";
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
      if (locale === "pl") return polishInterval(n, unit);
      const unitLabel = n === 1 ? cronUnitLabelSingular(unit) : cronUnitLabel(unit);
      if (suffixInterval) return { lead: "", detail: t`every ${n} ${ph({ unit: unitLabel })}` };
      return { lead: t`Every`, detail: t`${n} ${ph({ unit: unitLabel })}` };
    },
    atTime: (time) => t`at ${ph({ time: localizedClock(time, locale) })}`,
    atTimes: (clocks) => {
      const times = clocks.map((time) => localizedClock(time, locale));
      return t`at ${ph({ times: times.slice(0, -1).join(listSeparator) })} and ${ph({ last: times.at(-1) ?? "" })}`;
    },
    onThe1stAt: (time) => t`on the 1st at ${ph({ time: localizedClock(time, locale) })}`,
    onDayAt: (day, time) => t`on day ${day} at ${ph({ time: localizedClock(time, locale) })}`,
    hourAtMinute: (minute) => t`Every hour at :${ph({ minute: String(minute).padStart(2, "0") })}`,
    hoursAtMinute: (hours, minute) =>
      t`Every ${ph({ n: hours })} hours at :${ph({ minute: String(minute).padStart(2, "0") })}`,
    daySpan: (fromName, toName) => t`${ph({ from: fromName })} to ${ph({ to: toName })}`,
    everyDays: (names) =>
      names.length === 1
        ? t`Every ${ph({ day: names[0] ?? "" })}`
        : t`Every ${ph({ days: names.slice(0, -1).join(listSeparator) })} and ${ph({ last: names.at(-1) ?? "" })}`,
  };
}
