import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  formatMinorAmount,
  parseLimitInput,
  parsePageAmount,
  spendingPeriodStart,
} from "./spending.js";
import { localTime, nearClockChange, zonedInstant } from "./time-zones.test-support.js";

describe("parsePageAmount", () => {
  it.each([
    ["$23.40", 2340, "usd"],
    ["$5", 500, "usd"],
    ["US$1,234.56", 123456, "usd"],
    ["1 234,56 €", 123456, "eur"],
    ["€12,5", 1250, "eur"],
    ["£0.99", 99, "gbp"],
    ["₪50", 5000, "ils"],
    ['120 ש"ח', 12000, "ils"],
    ["NIS 7.90", 790, "ils"],
    ["EUR 1.234,00", 123400, "eur"],
    ["USD 10", 1000, "usd"],
    // Every other dollar is worth less, so reading it as US dollars over-counts.
    ["CA$10.00", 1000, "usd"],
    // A separator before three digits groups thousands: the larger reading.
    ["$1.234", 123400, "usd"],
    ["$1,000,000", 100000000, "usd"],
    // A decimal part with no whole part is still a fraction, not whole units.
    ["$.99", 99, "usd"],
    ["€,50", 50, "eur"],
    [".99 USD", 99, "usd"],
    [",50 €", 50, "eur"],
    ["$.5", 50, "usd"],
    ["$0.99", 99, "usd"],
    ["€0,50", 50, "eur"],
    ["$00.99", 99, "usd"],
  ])("reads %s", (text, amount, currency) => {
    expect(parsePageAmount(text)).toEqual({ amount, currency });
  });

  it.each([
    "",
    "Total",
    "¥1,200",
    "12.00",
    "$1 or €2",
    "$5 and $6",
    "₹500",
    "$",
    "$1,2,3",
    "$1.2345",
    "$1,234,56",
    "$30,000,000",
    "$..99",
    "$,.99",
    "$.999",
    "€,500",
    "$.1,234",
  ])("refuses %j", (text) => {
    expect(parsePageAmount(text)).toBeNull();
  });
});

describe("spendingPeriodStart", () => {
  const set = new Date("2026-01-01T00:00:00Z");
  // A Wednesday evening in New York, already Thursday in UTC.
  const now = new Date("2026-11-05T02:30:00Z");

  it("starts a day at local midnight", () => {
    expect(spendingPeriodStart("day", set, "America/New_York", now).toISOString()).toBe(
      "2026-11-04T05:00:00.000Z",
    );
    expect(spendingPeriodStart("day", set, null, now).toISOString()).toBe(
      "2026-11-05T00:00:00.000Z",
    );
  });

  it("starts a week on Monday", () => {
    expect(spendingPeriodStart("week", set, "America/New_York", now).toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
    // Monday itself starts its own week.
    expect(
      spendingPeriodStart("week", set, "UTC", new Date("2026-11-02T00:00:00Z")).toISOString(),
    ).toBe("2026-11-02T00:00:00.000Z");
    // Sunday belongs to the week that began six days earlier.
    expect(
      spendingPeriodStart("week", set, "UTC", new Date("2026-11-08T23:59:00Z")).toISOString(),
    ).toBe("2026-11-02T00:00:00.000Z");
  });

  it("starts a month on the first, across a daylight-saving change", () => {
    expect(spendingPeriodStart("month", set, "America/New_York", now).toISOString()).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    expect(spendingPeriodStart("month", set, "Asia/Jerusalem", now).toISOString()).toBe(
      "2026-10-31T22:00:00.000Z",
    );
  });

  it("counts a limit that never resets from when it was set", () => {
    expect(spendingPeriodStart("none", set, "Asia/Jerusalem", now)).toBe(set);
  });
});

describe("formatMinorAmount", () => {
  it.each([
    [1000, "jpy", "¥1,000"],
    [1000, "JPY", "¥1,000"],
    [0, "jpy", "¥0"],
    [1000, "krw", "₩1,000"],
    [1234, "kwd", "KWD\u00a01.234"],
    [2340, "eur", "€23.40"],
    [2340, "gbp", "£23.40"],
  ])("formats %s minor units of %s", (amount, currency, expected) => {
    expect(formatMinorAmount(amount, currency)).toBe(expected);
  });

  it("uses the requested locale without changing the currency scale", () => {
    expect(formatMinorAmount(1000, "jpy", "ja-JP")).toBe("￥1,000");
    expect(formatMinorAmount(1234, "kwd", "de-DE")).toBe("1,234\u00a0KWD");
  });

  it("keeps the existing fallback for invalid currency codes", () => {
    expect(formatMinorAmount(1234, "invalid")).toBe("12.34 INVALID");
  });

  it("formats minor units as money", () => {
    expect(formatMinorAmount(2340, "usd")).toBe("$23.40");
    expect(formatMinorAmount(5000, "ils", "en-US")).toBe("₪50.00");
  });
});

describe("parseLimitInput", () => {
  it.each([
    ["200", 20_000],
    ["200.5", 20_050],
    ["12,50", 1_250],
    ["1,000", 100_000],
    ["1 000", 100_000],
    [" 75 ", 7_500],
    ["1000000", 100_000_000],
  ])("reads %j", (text, amount) => {
    expect(parseLimitInput(text)).toBe(amount);
  });

  it.each(["", "0", "-5", "abc", "$20", "1e3", "1000001", "1,2,3", "1.2345"])(
    "refuses %j",
    (text) => {
      expect(parseLimitInput(text)).toBeNull();
    },
  );
});

describe("formatted amount properties", () => {
  const amount = fc.oneof(fc.nat(200_000), fc.nat(2_147_483_647), fc.nat(2 ** 40));
  const currency = fc.constantFrom("usd" as const, "eur" as const, "gbp" as const, "ils" as const);
  const locale = fc.constantFrom(
    ...["en-US", "en-GB", "en-IN", "en-AU", "en-ZA", "de-DE", "de-CH", "de-AT", "fr-FR", "fr-CA"],
    ...["es-ES", "es-MX", "it-IT", "nl-NL", "pt-BR", "sv-SE", "nb-NO", "pl-PL", "ru-RU", "tr-TR"],
    ...["he-IL", "ar-EG", "fa-IR", "hi-IN", "bn-BD", "ja-JP", "zh-CN", "vi-VN", "bg-BG", "hu-HU"],
  );

  it("reads an amount formatted in any locale back as that amount and currency, or not at all", () => {
    fc.assert(
      fc.property(amount, currency, locale, (amount, currency, locale) => {
        const text = formatMinorAmount(amount, currency, locale);
        expect([null, { amount, currency }]).toContainEqual(parsePageAmount(text));
      }),
      { seed: 42, numRuns: 300 },
    );
  });

  it("reads back every storable amount formatted the US, German or French way", () => {
    fc.assert(
      fc.property(
        fc.nat(2_147_483_647),
        currency,
        fc.constantFrom("en-US", "de-DE", "fr-FR"),
        (amount, currency, locale) => {
          expect(parsePageAmount(formatMinorAmount(amount, currency, locale))).toEqual({
            amount,
            currency,
          });
        },
      ),
      { seed: 42, numRuns: 150 },
    );
  });
});

describe("spendingPeriodStart properties", () => {
  const period = fc.constantFrom("day" as const, "week" as const, "month" as const);
  const set = new Date(0);

  it("starts a period at the first instant of its first local day, never after now", () => {
    fc.assert(
      fc.property(period, zonedInstant, (period, { timeZone, at }) => {
        const start = spendingPeriodStart(period, set, timeZone, at);
        expect(start.getTime()).toBeLessThanOrEqual(at.getTime());
        const local = localTime(start, timeZone);
        const now = localTime(at, timeZone);
        expect(localTime(new Date(start.getTime() - 1), timeZone).dayNumber).toBe(
          local.dayNumber - 1,
        );
        if (!nearClockChange(start, timeZone)) {
          expect([local.hour, local.minute, local.second]).toEqual([0, 0, 0]);
        }
        const age = now.dayNumber - local.dayNumber;
        if (period === "day") expect(age).toBe(0);
        if (period === "week") expect([local.weekday, age <= 6]).toEqual([1, true]);
        if (period === "month") {
          expect([local.year, local.month, local.day]).toEqual([now.year, now.month, 1]);
        }
      }),
      { seed: 42, numRuns: 200 },
    );
  });

  it("gives every instant between a period's start and a later one in it the same start", () => {
    fc.assert(
      fc.property(
        period,
        zonedInstant,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (period, { timeZone, at }, fraction) => {
          const start = spendingPeriodStart(period, set, timeZone, at);
          const within = new Date(
            start.getTime() + Math.floor((at.getTime() - start.getTime()) * fraction),
          );
          expect(spendingPeriodStart(period, set, timeZone, within)).toEqual(start);
          expect(spendingPeriodStart(period, set, timeZone, start)).toEqual(start);
        },
      ),
      { seed: 42, numRuns: 150 },
    );
  });
});
