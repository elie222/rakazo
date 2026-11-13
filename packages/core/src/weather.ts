import type { WeatherForecast } from "@rakazo/contracts";

export type WeatherScale = "celsius" | "fahrenheit";

/** The glyph a card draws for a condition. */
export type WeatherIcon =
  | "sun"
  | "moon"
  | "cloud-sun"
  | "cloud-moon"
  | "cloud"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "lightning";

/** The words a card shows for a condition; clients translate these keys. */
export type WeatherConditionKey =
  | "clear"
  | "mostlyClear"
  | "partlyCloudy"
  | "cloudy"
  | "fog"
  | "drizzle"
  | "rain"
  | "freezingRain"
  | "snow"
  | "showers"
  | "snowShowers"
  | "thunderstorm";

const HOUR_MS = 3_600_000;
export const WEATHER_COLLAPSED_DAYS = 5;
export const WEATHER_HOURLY_COUNT = 24;
/** A chance above this, or any rain-like condition, earns a percentage under a daily icon. */
const PRECIP_LIKELY_PERCENT = 40;

/** A WMO weather code as the condition it names; an unknown code reads as clear. */
export function weatherCondition(code: number): WeatherConditionKey {
  if (code === 0) return "clear";
  if (code === 1) return "mostlyClear";
  if (code === 2) return "partlyCloudy";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 55) return "drizzle";
  if (code === 56 || code === 57 || code === 66 || code === 67) return "freezingRain";
  if (code >= 61 && code <= 65) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "showers";
  if (code === 85 || code === 86) return "snowShowers";
  if (code >= 95) return "thunderstorm";
  return "clear";
}

export function weatherIcon(code: number, isDay: boolean): WeatherIcon {
  switch (weatherCondition(code)) {
    case "clear":
      return isDay ? "sun" : "moon";
    case "mostlyClear":
    case "partlyCloudy":
      return isDay ? "cloud-sun" : "cloud-moon";
    case "cloudy":
      return "cloud";
    case "fog":
      return "fog";
    case "drizzle":
      return "drizzle";
    case "rain":
    case "freezingRain":
    case "showers":
      return "rain";
    case "snow":
    case "snowShowers":
      return "snow";
    case "thunderstorm":
      return "lightning";
  }
}

const FAHRENHEIT_REGIONS = new Set(["US", "LR", "MM", "BS", "BZ", "KY", "PW", "FM", "MH"]);

/** °F for the few places that use it, °C everywhere else, from a BCP 47 locale. */
export function defaultWeatherScale(locale: string | undefined): WeatherScale {
  if (!locale) return "celsius";
  let region: string | undefined;
  try {
    region = new Intl.Locale(locale).maximize().region;
  } catch {
    return "celsius";
  }
  return region && FAHRENHEIT_REGIONS.has(region) ? "fahrenheit" : "celsius";
}

export function weatherTemperature(celsius: number, scale: WeatherScale): number {
  const value = scale === "fahrenheit" ? (celsius * 9) / 5 + 32 : celsius;
  // Math.round turns -0.4 into -0, which would print as "-0°".
  return Math.round(value) + 0;
}

/** Wind as a rounded number with its unit, km/h or mph following the scale. */
export function weatherWind(
  kph: number,
  scale: WeatherScale,
): { value: number; unit: "km/h" | "mph" } {
  return scale === "fahrenheit"
    ? { value: Math.round(kph / 1.609344), unit: "mph" }
    : { value: Math.round(kph), unit: "km/h" };
}

/** The hours the strip shows: the one in progress at `asOfMs` (flagged `now`), then the next. */
export function weatherHourlyWindow(
  forecast: Pick<WeatherForecast, "hours" | "asOfMs">,
  count = WEATHER_HOURLY_COUNT,
) {
  return forecast.hours
    .filter((hour) => hour.startMs + HOUR_MS > forecast.asOfMs)
    .slice(0, count)
    .map((hour) => ({ ...hour, now: hour.startMs <= forecast.asOfMs }));
}

function localDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(ms);
}

/** The day row for the day the forecast was fetched, if the card has it. */
export function weatherToday(forecast: Pick<WeatherForecast, "days" | "asOfMs" | "timeZone">) {
  const today = localDate(forecast.asOfMs, forecast.timeZone);
  return forecast.days.find((day) => localDate(day.startMs, forecast.timeZone) === today);
}

export function weatherPrecipLikely(day: { code: number; precipChance: number }): boolean {
  if (day.precipChance > PRECIP_LIKELY_PERCENT) return true;
  const condition = weatherCondition(day.code);
  return (
    condition === "drizzle" ||
    condition === "rain" ||
    condition === "freezingRain" ||
    condition === "snow" ||
    condition === "showers" ||
    condition === "snowShowers" ||
    condition === "thunderstorm"
  );
}

/** Daily rows shown collapsed (five) or all of them. */
export function weatherVisibleDays<T>(days: readonly T[], expanded: boolean): T[] {
  return expanded ? [...days] : days.slice(0, WEATHER_COLLAPSED_DAYS);
}

export function weatherCanExpand(days: readonly unknown[]): boolean {
  return days.length > WEATHER_COLLAPSED_DAYS;
}

/** Where a day's low-to-high fill sits on a track spanning every day, as 0..1 fractions. */
export function weatherRangeFill(
  days: readonly { minC: number; maxC: number }[],
  day: { minC: number; maxC: number },
): { start: number; end: number } {
  const low = Math.min(...days.map((d) => d.minC));
  const high = Math.max(...days.map((d) => d.maxC));
  if (high <= low) return { start: 0, end: 1 };
  return { start: (day.minC - low) / (high - low), end: (day.maxC - low) / (high - low) };
}

export type WeatherBand = "blue" | "cyan" | "green" | "yellow" | "orange" | "red";

/** Lower edge in °C of each band the range fill is coloured by. */
const BANDS: readonly [number, WeatherBand][] = [
  [-Infinity, "blue"],
  [0, "blue"],
  [8, "cyan"],
  [14, "green"],
  [21, "yellow"],
  [27, "orange"],
  [33, "red"],
];

export function weatherBand(celsius: number): WeatherBand {
  let band: WeatherBand = "blue";
  for (const [from, name] of BANDS) if (celsius >= from) band = name;
  return band;
}

/** Gradient stops (0..1 along the fill) from a day's low to its high. */
export function weatherFillStops(minC: number, maxC: number): { at: number; band: WeatherBand }[] {
  const edges = [
    minC,
    ...BANDS.map(([from]) => from).filter((from) => from > minC && from < maxC),
    maxC,
  ];
  const span = maxC - minC;
  return edges.map((edge) => ({
    at: span > 0 ? (edge - minC) / span : 0,
    band: weatherBand(edge),
  }));
}
