import { describe, expect, it } from "vitest";
import {
  defaultWeatherScale,
  weatherBand,
  weatherCanExpand,
  weatherCondition,
  weatherFillStops,
  weatherHourlyWindow,
  weatherIcon,
  weatherRangeFill,
  weatherTemperature,
  weatherToday,
  weatherVisibleDays,
  weatherWind,
} from "./weather.js";

const HOUR = 3_600_000;

describe("weather view model", () => {
  it("maps WMO codes to conditions and day or night icons", () => {
    expect(weatherCondition(0)).toBe("clear");
    expect(weatherCondition(63)).toBe("rain");
    expect(weatherCondition(96)).toBe("thunderstorm");
    expect(weatherCondition(1234)).toBe("thunderstorm");
    expect(weatherIcon(0, true)).toBe("sun");
    expect(weatherIcon(0, false)).toBe("moon");
    expect(weatherIcon(2, false)).toBe("cloud-moon");
    expect(weatherIcon(67, true)).toBe("rain");
    expect(weatherIcon(86, true)).toBe("snow");
  });

  it("uses Fahrenheit only for the regions that do", () => {
    expect(defaultWeatherScale("en-US")).toBe("fahrenheit");
    expect(defaultWeatherScale("en")).toBe("fahrenheit");
    expect(defaultWeatherScale("en-GB")).toBe("celsius");
    expect(defaultWeatherScale("he")).toBe("celsius");
    expect(defaultWeatherScale("fr-FR")).toBe("celsius");
    expect(defaultWeatherScale("not a locale!!")).toBe("celsius");
    expect(defaultWeatherScale(undefined)).toBe("celsius");
  });

  it("converts and rounds temperature and wind", () => {
    expect(weatherTemperature(8.4, "celsius")).toBe(8);
    expect(weatherTemperature(0, "fahrenheit")).toBe(32);
    expect(weatherTemperature(-0.3, "celsius")).toBe(0);
    expect(Object.is(weatherTemperature(-0.3, "celsius"), -0)).toBe(false);
    expect(weatherWind(12, "celsius")).toEqual({ value: 12, unit: "km/h" });
    expect(weatherWind(16.09344, "fahrenheit")).toEqual({ value: 10, unit: "mph" });
  });

  it("starts the hourly strip at the hour in progress", () => {
    const start = Date.UTC(2026, 0, 15, 8);
    const hours = Array.from({ length: 30 }, (_, i) => ({
      startMs: start + (i - 3) * HOUR,
      code: 0,
      isDay: true,
      temperatureC: 5,
      precipChance: 0,
    }));
    const window = weatherHourlyWindow({ hours, asOfMs: start + 31 * 60_000 });
    expect(window).toHaveLength(24);
    expect(window[0]).toMatchObject({ startMs: start, now: true });
    expect(window[1]?.now).toBe(false);
  });

  it("finds today in the card's own time zone", () => {
    // 23:30 UTC on the 14th is already the 15th in Auckland.
    const asOfMs = Date.UTC(2026, 0, 14, 23, 30);
    const auckland = Date.UTC(2026, 0, 14, 11, 0); // 00:00 on the 15th, NZDT
    const days = [{ startMs: auckland - 24 * HOUR }, { startMs: auckland }] as never;
    expect(weatherToday({ days, asOfMs, timeZone: "Pacific/Auckland" })).toBe(
      (days as { startMs: number }[])[1],
    );
  });

  it("collapses to five days and normalises range bars", () => {
    const days = Array.from({ length: 8 }, (_, i) => ({ minC: i, maxC: i + 10 }));
    expect(weatherCanExpand(days)).toBe(true);
    expect(weatherCanExpand(days.slice(0, 5))).toBe(false);
    expect(weatherVisibleDays(days, false)).toHaveLength(5);
    expect(weatherVisibleDays(days, true)).toHaveLength(8);
    expect(weatherRangeFill(days, days[0]!)).toEqual({ start: 0, end: 10 / 17 });
    expect(weatherRangeFill([{ minC: 3, maxC: 3 }], { minC: 3, maxC: 3 })).toEqual({
      start: 0,
      end: 1,
    });
  });

  it("colours the fill by temperature band", () => {
    expect(weatherBand(-5)).toBe("blue");
    expect(weatherBand(9)).toBe("cyan");
    expect(weatherBand(35)).toBe("red");
    expect(weatherFillStops(4, 9).map((s) => s.band)).toEqual(["blue", "cyan", "cyan"]);
    const stops = weatherFillStops(-2, 30);
    expect(stops[0]).toEqual({ at: 0, band: "blue" });
    expect(stops.at(-1)).toEqual({ at: 1, band: "orange" });
  });
});
