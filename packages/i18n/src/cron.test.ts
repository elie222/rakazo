import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import { formatCron } from "@rakazo/core";
import { afterEach, describe, expect, it } from "vitest";
import { messages as de } from "../locales/de/messages.po";
import { messages as ja } from "../locales/ja/messages.po";
import { messages as pl } from "../locales/pl/messages.po";
import { messages as ru } from "../locales/ru/messages.po";
import { messages as zhCN } from "../locales/zh-CN/messages.po";
import { messages as zhTW } from "../locales/zh-TW/messages.po";
import { cronLabels } from "./cron";

const catalogs: Record<string, Messages> = { de, ja, pl, ru, "zh-CN": zhCN, "zh-TW": zhTW };

/** Schedule words in `locale`, with its catalog active as in either app. */
function labelsIn(locale: string) {
  i18n.load(locale, catalogs[locale] ?? {});
  i18n.activate(locale);
  return cronLabels(locale);
}

afterEach(() => i18n.activate("en"));

describe("cronLabels", () => {
  it("keeps English schedules readable, including an interval of one", () => {
    const labels = cronLabels("en");
    expect(formatCron("*/1 * * * *", labels)).toBe("Every 1 minute");
    expect(formatCron("0 8 * * 1-5", labels)).toBe("Weekdays at 8:00 AM");
    expect(formatCron("43 */2 * * *", labels)).toBe("Every 2 hours at :43");
  });

  it("writes times the way the language does, even before its words are translated", () => {
    i18n.activate("en");
    expect(formatCron("0 21 * * 1-5", cronLabels("es"))).toBe("Weekdays at 21:00");
    expect(formatCron("30 7 1 * *", cronLabels("es"))).toBe("Monthly on day 1 at 7:30");
    expect(formatCron("15 */2 * * *", cronLabels("es"))).toBe("Every 2 hours at :15");
  });

  it("localizes each clock in a list of run times", () => {
    i18n.activate("en");
    expect(formatCron("0 9,17 * * 1-5", cronLabels("es"))).toBe("Weekdays at 9:00 and 17:00");
  });

  it("translates schedules into Chinese as one interval phrase", () => {
    expect(formatCron("0 8 * * 1-5", labelsIn("zh-CN"))).toBe("工作日 8:00");
    const traditional = labelsIn("zh-TW");
    expect(formatCron("0 8 * * 1-5", traditional)).toBe("工作日 上午8:00");
    expect(formatCron("*/5 * * * *", traditional)).toBe("每 5 分鐘");
    expect(formatCron("43 */2 * * *", traditional)).toBe("每 2 小時 43 分");
  });

  it("lists days with the ideographic comma in Japanese", () => {
    const labels = labelsIn("ja");
    expect(formatCron("0 8 * * 1,3,5", labels)).toContain("、");
    expect(formatCron("0 8 * * 1,3,5", labels)).not.toContain(", ");
  });

  it("writes German times and minutes", () => {
    const labels = labelsIn("de");
    expect(formatCron("30 18 * * 2", labels)).toBe("Jeden Dienstag um 18:30");
    expect(formatCron("0 21 1 * *", labels)).toBe("Monatlich am 1. um 21:00");
    expect(formatCron("5 */6 * * *", labels)).toBe("Alle 6 Stunden um :05");
  });

  it("uses Polish case forms for intervals and weekday lists", () => {
    const labels = labelsIn("pl");
    expect(formatCron("*/1 * * * *", labels)).toBe("Co minutę");
    expect(formatCron("*/2 * * * *", labels)).toBe("Co 2 minuty");
    expect(formatCron("*/5 * * * *", labels)).toBe("Co 5 minut");
    expect(formatCron("*/12 * * * *", labels)).toBe("Co 12 minut");
    expect(formatCron("*/22 * * * *", labels)).toBe("Co 22 minuty");
    expect(formatCron("0 */3 * * *", labels)).toBe("Co 3 godziny");
    expect(formatCron("0 0 */5 * *", labels)).toBe("Co 5 dni");
    expect(formatCron("30 18 * * 2", labels)).toBe("Co tydzień: wtorek o 18:30");
    expect(formatCron("0 8 * * 2,4", labels)).toBe("Co tydzień: wtorek i czwartek o 8:00");
    expect(formatCron("0 8 * * 2-4", labels)).toBe("wtorek-czwartek o 8:00");
  });

  it("uses Russian case forms for intervals", () => {
    const labels = labelsIn("ru");
    expect(formatCron("*/1 * * * *", labels)).toBe("Каждую минуту");
    expect(formatCron("*/5 * * * *", labels)).toBe("Каждые 5 минут");
    expect(formatCron("0 8 * * 1-5", labels)).toBe("Будни в 8:00");
    expect(formatCron("43 */3 * * *", labels)).toBe("Раз в 3 ч, на 43-й минуте");
  });
});
