import type { CronLabels, CronUnit } from "@rakazo/core";
import { ENGLISH_CRON_LABELS, localizedClock, russianInterval } from "@rakazo/core";
import { getActiveUiLocale, t } from "./i18n";
import type { UiLocale } from "./ui-locale";

function unitLabelPlural(unit: CronUnit): string {
  switch (unit) {
    case "minutes":
      return t("minutes");
    case "hours":
      return t("hours");
    case "days":
      return t("days");
    default:
      return unit;
  }
}

function unitLabelSingular(unit: CronUnit): string {
  switch (unit) {
    case "minutes":
      return t("minute");
    case "hours":
      return t("hour");
    case "days":
      return t("day");
    default:
      return unit;
  }
}

/**
 * Schedule words for `formatCron` — routine rows, the status line, the `@`
 * picker. Russian intervals need case forms, so they share the core helper
 * instead of a catalog string.
 */
export function cronLabels(locale: UiLocale = getActiveUiLocale()): CronLabels {
  if (locale === "en") return ENGLISH_CRON_LABELS;
  const listSeparator = locale === "ja" || locale === "zh-CN" || locale === "zh-TW" ? "、" : ", ";
  return {
    oneTime: t("One-time"),
    everyHour: t("Every hour"),
    cron: t("Cron"),
    everyDay: t("Every day"),
    weekdays: t("Weekdays"),
    weekends: t("Weekends"),
    everyMonday: t("Every Monday"),
    monthly: t("Monthly"),
    weekdayNames: [
      t("Sunday"),
      t("Monday"),
      t("Tuesday"),
      t("Wednesday"),
      t("Thursday"),
      t("Friday"),
      t("Saturday"),
    ],
    interval: (n, unit) => {
      if (locale === "ru") return russianInterval(n, unit);
      const unitLabel = n === 1 ? unitLabelSingular(unit) : unitLabelPlural(unit);
      // zh/ja read most naturally as one suffix phrase ("每5分钟", "5分ごと").
      if (locale === "zh-CN" || locale === "zh-TW" || locale === "ja") {
        return { lead: "", detail: t("every {n} {unit}", { n, unit: unitLabel }) };
      }
      return { lead: t("Every"), detail: t("{n} {unit}", { n, unit: unitLabel }) };
    },
    atTime: (time) => t("at {time}", { time: localizedClock(time, locale) }),
    onThe1stAt: (time) => t("on the 1st at {time}", { time: localizedClock(time, locale) }),
    onDayAt: (day, time) =>
      t("on day {day} at {time}", { day, time: localizedClock(time, locale) }),
    hourAtMinute: (minute) =>
      t("Every hour at :{minute}", { minute: String(minute).padStart(2, "0") }),
    hoursAtMinute: (hours, minute) =>
      t("Every {n} hours at :{minute}", { n: hours, minute: String(minute).padStart(2, "0") }),
    daySpan: (fromName, toName) => t("{from} to {to}", { from: fromName, to: toName }),
    everyDays: (names) =>
      names.length === 1
        ? t("Every {day}", { day: names[0] ?? "" })
        : t("Every {days} and {last}", {
            days: names.slice(0, -1).join(listSeparator),
            last: names.at(-1) ?? "",
          }),
  };
}
