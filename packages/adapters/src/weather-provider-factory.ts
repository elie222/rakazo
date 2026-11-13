import type { WeatherProvider } from "@rakazo/adapter-kit";
import { FakeWeatherProvider } from "./fake-weather.js";
import { OpenMeteoWeatherProvider } from "./open-meteo-weather.js";

/** Open-Meteo is the keyless default; WEATHER_PROVIDER=fake serves a fixed forecast for tests. */
export function createWeatherProvider(source: NodeJS.ProcessEnv = process.env): WeatherProvider {
  const kind = source.WEATHER_PROVIDER?.trim().toLowerCase();
  switch (kind) {
    case "fake":
      return new FakeWeatherProvider();
    case undefined:
    case "":
    case "open-meteo":
      return new OpenMeteoWeatherProvider({
        geocodingUrl: source.OPEN_METEO_GEOCODING_URL?.trim() || undefined,
        forecastUrl: source.OPEN_METEO_FORECAST_URL?.trim() || undefined,
      });
    default:
      throw new Error(`Unknown weather provider "${kind}"`);
  }
}
