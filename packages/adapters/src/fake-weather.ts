import type { AdapterContext, WeatherProvider, WeatherRequest } from "@rakazo/adapter-kit";
import type { WeatherForecast } from "@rakazo/contracts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A deterministic forecast for offline tests: never touches the network. */
export function fakeWeatherForecast(
  label: string,
  days = 7,
  now = Date.UTC(2026, 0, 15, 8, 31),
): WeatherForecast {
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const midnight = Math.floor(now / DAY_MS) * DAY_MS;
  const codes = [0, 2, 61, 3, 71, 95, 45];
  return {
    locationLabel: label,
    timeZone: "UTC",
    asOfMs: now,
    current: {
      code: 0,
      isDay: true,
      temperatureC: 8,
      apparentC: 7.6,
      humidity: 68,
      windKph: 12,
    },
    hours: Array.from({ length: 30 }, (_, i) => ({
      startMs: hourStart + i * HOUR_MS,
      code: codes[Math.floor(i / 5) % codes.length] ?? 0,
      isDay: (i + 8) % 24 >= 7 && (i + 8) % 24 < 18,
      temperatureC: 7 + Math.round(Math.sin(i / 4) * 3),
      precipChance: i % 7 === 3 ? 60 : 5,
    })),
    days: Array.from({ length: days }, (_, i) => ({
      startMs: midnight + i * DAY_MS,
      code: codes[i % codes.length] ?? 0,
      maxC: 9 - (i % 3),
      minC: 4 - (i % 4),
      precipChance: i === 2 ? 45 : 10,
      precipMm: i === 2 ? 3.2 : 0,
    })),
    attribution: { name: "Open-Meteo", url: "https://open-meteo.com/" },
  };
}

export class FakeWeatherProvider implements WeatherProvider {
  lastRequest?: WeatherRequest;
  error?: Error;

  describe() {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { keyless: true },
    };
  }

  async forecast(request: WeatherRequest, _context: AdapterContext): Promise<WeatherForecast> {
    this.lastRequest = request;
    if (this.error) throw this.error;
    return fakeWeatherForecast(request.location ?? "Fakeville", request.days ?? 7);
  }
}
