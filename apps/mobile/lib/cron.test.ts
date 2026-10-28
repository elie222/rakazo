import { formatCron } from "@rakazo/core";
import { afterEach, describe, expect, it } from "vitest";
import { cronLabels } from "./cron";
import { resetI18nForTests } from "./i18n";

afterEach(() => resetI18nForTests());

describe("cronLabels", () => {
  it("keeps English schedules readable, including an interval of one", () => {
    const labels = cronLabels("en");
    expect(formatCron("*/1 * * * *", labels)).toBe("Every 1 minute");
    expect(formatCron("0 8 * * 1-5", labels)).toBe("Weekdays at 8:00 AM");
  });

  it("translates schedules on mobile surfaces", () => {
    resetI18nForTests("zh-CN");
    const labels = cronLabels();
    expect(formatCron("0 8 * * 1-5", labels)).toBe("工作日 8:00 AM");
    expect(formatCron("*/5 * * * *", labels)).toBe("每5分钟");
  });

  it("translates schedules into Traditional Chinese", () => {
    resetI18nForTests("zh-TW");
    const labels = cronLabels();
    expect(formatCron("0 8 * * 1-5", labels)).toBe("平日 8:00 AM");
    expect(formatCron("*/5 * * * *", labels)).toBe("每 5 分鐘");
  });

  it("names a fixed minute every few hours in each language", () => {
    expect(formatCron("43 */2 * * *", cronLabels("en"))).toBe("Every 2 hours at :43");
    resetI18nForTests("de");
    expect(formatCron("5 */6 * * *", cronLabels())).toBe("Alle 6 Stunden um :05");
    resetI18nForTests("zh-TW");
    expect(formatCron("43 */2 * * *", cronLabels())).toBe("每 2 小時 43 分");
    resetI18nForTests("ru");
    expect(formatCron("43 */3 * * *", cronLabels())).toBe("Раз в 3 ч, на 43-й минуте");
  });

  it("uses Russian case forms for intervals", () => {
    resetI18nForTests("ru");
    const labels = cronLabels();
    expect(formatCron("*/1 * * * *", labels)).toBe("Каждую минуту");
    expect(formatCron("*/5 * * * *", labels)).toBe("Каждые 5 минут");
    expect(formatCron("0 8 * * 1-5", labels)).toBe("По будням в 8:00 AM");
  });
});
