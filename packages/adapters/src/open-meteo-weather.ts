import type { AdapterContext, WeatherProvider, WeatherRequest } from "@rakazo/adapter-kit";
import type { WeatherForecast } from "@rakazo/contracts";
import { WEATHER_MAX_DAYS, WEATHER_MAX_HOURS, WeatherForecastSchema } from "@rakazo/contracts";

export const DEFAULT_WEATHER_DAYS = 7;

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const HOUR_MS = 3_600_000;

export type OpenMeteoWeatherOptions = {
  fetch?: typeof globalThis.fetch;
  /** Overrides for a self-hosted Open-Meteo. */
  geocodingUrl?: string;
  forecastUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
};

type GeocodingResponse = {
  results?: {
    name?: string;
    country?: string;
    admin1?: string;
    latitude?: number;
    longitude?: number;
  }[];
};

type ForecastResponse = {
  timezone?: string;
  current?: {
    time?: number;
    temperature_2m?: number | null;
    apparent_temperature?: number | null;
    relative_humidity_2m?: number | null;
    weather_code?: number | null;
    wind_speed_10m?: number | null;
    is_day?: number | null;
  };
  hourly?: {
    time?: number[];
    temperature_2m?: (number | null)[];
    weather_code?: (number | null)[];
    is_day?: (number | null)[];
    precipitation_probability?: (number | null)[];
  };
  daily?: {
    time?: number[];
    weather_code?: (number | null)[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    precipitation_probability_max?: (number | null)[];
    precipitation_sum?: (number | null)[];
  };
};

export function clampWeatherDays(value: unknown): number {
  const days =
    typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_WEATHER_DAYS;
  return Math.min(Math.max(days, 1), WEATHER_MAX_DAYS);
}

function percent(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(value, 0), 100)
    : 0;
}

/** Keyless weather from Open-Meteo. Only the place name or coordinates leave the server. */
export class OpenMeteoWeatherProvider implements WeatherProvider {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly geocodingUrl: string;
  private readonly forecastUrl: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: OpenMeteoWeatherOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.geocodingUrl = options.geocodingUrl ?? GEOCODING_URL;
    this.forecastUrl = options.forecastUrl ?? FORECAST_URL;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.userAgent =
      options.userAgent ?? "Rakazo/0.1 (+https://github.com/elie222/rakazo; weather tool)";
  }

  describe() {
    return {
      id: "open-meteo",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { keyless: true },
    };
  }

  private async getJson<T>(url: URL, signal: AbortSignal | undefined): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: "application/json", "user-agent": this.userAgent },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new Error("The weather service could not be reached. Try again later.");
    }
    if (!response.ok) {
      throw new Error(`The weather service answered ${response.status}. Try again later.`);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new Error("The weather service sent a reply that could not be read.");
    }
  }

  private async resolvePlace(request: WeatherRequest) {
    const { latitude, longitude } = request;
    const location = request.location?.trim();
    const hasCoordinates = latitude !== undefined || longitude !== undefined;
    if (hasCoordinates && location) {
      throw new Error("Give either a location name or latitude and longitude, not both.");
    }
    if (hasCoordinates) {
      if (
        typeof latitude !== "number" ||
        typeof longitude !== "number" ||
        !(latitude >= -90 && latitude <= 90) ||
        !(longitude >= -180 && longitude <= 180)
      ) {
        throw new Error("latitude must be -90 to 90 and longitude -180 to 180, given together.");
      }
      return {
        latitude,
        longitude,
        label: `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`,
      };
    }
    if (!location) throw new Error("Give a location name, or latitude and longitude.");
    const url = new URL(this.geocodingUrl);
    url.searchParams.set("name", location);
    url.searchParams.set("count", "1");
    url.searchParams.set("language", "en");
    url.searchParams.set("format", "json");
    const found = await this.getJson<GeocodingResponse>(url, request.signal);
    const place = found.results?.[0];
    if (
      !place ||
      typeof place.latitude !== "number" ||
      typeof place.longitude !== "number" ||
      !place.name
    ) {
      throw new Error(`No place named "${location.slice(0, 80)}" was found. Try a nearby city.`);
    }
    return {
      latitude: place.latitude,
      longitude: place.longitude,
      label: [place.name, place.country].filter(Boolean).join(", "),
    };
  }

  async forecast(request: WeatherRequest, _context: AdapterContext): Promise<WeatherForecast> {
    const place = await this.resolvePlace(request);
    const days = clampWeatherDays(request.days);
    const url = new URL(this.forecastUrl);
    const q = url.searchParams;
    q.set("latitude", String(place.latitude));
    q.set("longitude", String(place.longitude));
    q.set(
      "current",
      "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
    );
    q.set("hourly", "temperature_2m,weather_code,is_day,precipitation_probability");
    q.set(
      "daily",
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
    );
    q.set("timezone", "auto");
    q.set("timeformat", "unixtime");
    q.set("wind_speed_unit", "kmh");
    q.set("temperature_unit", "celsius");
    // Two days at least, so a one-day card still has a full run of hours after now.
    q.set("forecast_days", String(Math.max(days, 2)));
    const data = await this.getJson<ForecastResponse>(url, request.signal);

    const { current, hourly, daily } = data;
    if (!current || !daily?.time?.length || !data.timezone) {
      throw new Error("The weather service sent no forecast for that place.");
    }
    const asOfMs = (current.time ?? Math.floor(Date.now() / 1000)) * 1000;
    const hours = (hourly?.time ?? [])
      .map((time, i) => ({
        startMs: time * 1000,
        code: hourly?.weather_code?.[i],
        isDay: hourly?.is_day?.[i] !== 0,
        temperatureC: hourly?.temperature_2m?.[i],
        precipChance: percent(hourly?.precipitation_probability?.[i]),
      }))
      .filter((hour) => hour.startMs + HOUR_MS > asOfMs)
      .filter(
        (hour): hour is typeof hour & { code: number; temperatureC: number } =>
          typeof hour.code === "number" && typeof hour.temperatureC === "number",
      )
      .slice(0, WEATHER_MAX_HOURS);
    const rows = daily.time
      .slice(0, days)
      .map((time, i) => ({
        startMs: time * 1000,
        code: daily.weather_code?.[i],
        maxC: daily.temperature_2m_max?.[i],
        minC: daily.temperature_2m_min?.[i],
        precipChance: percent(daily.precipitation_probability_max?.[i]),
        precipMm: Math.max(daily.precipitation_sum?.[i] ?? 0, 0),
      }))
      .filter(
        (day): day is typeof day & { code: number; maxC: number; minC: number } =>
          typeof day.code === "number" &&
          typeof day.maxC === "number" &&
          typeof day.minC === "number",
      );

    const parsed = WeatherForecastSchema.safeParse({
      locationLabel: place.label.slice(0, 200),
      timeZone: data.timezone,
      asOfMs,
      current: {
        code: current.weather_code,
        isDay: current.is_day !== 0,
        temperatureC: current.temperature_2m,
        apparentC: current.apparent_temperature ?? current.temperature_2m,
        humidity: percent(current.relative_humidity_2m),
        windKph: Math.max(current.wind_speed_10m ?? 0, 0),
      },
      hours,
      days: rows,
      attribution: { name: "Open-Meteo", url: "https://open-meteo.com/" },
    });
    if (!parsed.success)
      throw new Error("The weather service sent a forecast that was incomplete.");
    return parsed.data;
  }
}
