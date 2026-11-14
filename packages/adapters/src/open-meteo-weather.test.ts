import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clampWeatherDays, OpenMeteoWeatherProvider } from "./open-meteo-weather.js";

const context = {} as AdapterContext;
const DAY = 86_400;
const NOW = Date.UTC(2026, 0, 15, 8, 30) / 1000;

function forecastBody(days: number) {
  const midnight = Math.floor(NOW / DAY) * DAY;
  const hourStart = Math.floor(NOW / 3600) * 3600;
  const hours = Array.from({ length: days * 24 }, (_, i) => hourStart - 8 * 3600 + i * 3600);
  const fill = <T>(n: number, value: T) => Array.from({ length: n }, () => value);
  return {
    timezone: "Europe/Rome",
    current: {
      time: NOW,
      temperature_2m: 8.2,
      apparent_temperature: 7.6,
      relative_humidity_2m: 68,
      weather_code: 0,
      wind_speed_10m: 12.4,
      is_day: 1,
    },
    hourly: {
      time: hours,
      temperature_2m: fill(hours.length, 8),
      weather_code: fill(hours.length, 1),
      is_day: fill(hours.length, 1),
      precipitation_probability: hours.map((_, i) => (i === 0 ? null : 20)),
    },
    daily: {
      time: Array.from({ length: days }, (_, i) => midnight + i * DAY),
      weather_code: fill(days, 3),
      temperature_2m_max: fill(days, 9),
      temperature_2m_min: fill(days, 4),
      precipitation_probability_max: fill(days, 45),
      precipitation_sum: fill(days, 1.5),
    },
  };
}

describe("OpenMeteoWeatherProvider", () => {
  let server: Server;
  let base: string;
  const seen: string[] = [];
  let mode: "ok" | "down" | "garbage" = "ok";

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://mock");
      seen.push(`${url.pathname}?${url.searchParams.toString()}`);
      if (mode === "down") {
        res.statusCode = 503;
        res.end("busy");
        return;
      }
      if (mode === "garbage") {
        res.end("<html>");
        return;
      }
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/geo") {
        res.end(
          JSON.stringify(
            url.searchParams.get("name")?.startsWith("Nowhereville")
              ? {}
              : {
                  results: [
                    { name: "Lisbon", country: "Portugal", latitude: 38.72, longitude: -9.14 },
                  ],
                },
          ),
        );
        return;
      }
      res.end(JSON.stringify(forecastBody(Number(url.searchParams.get("forecast_days")))));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  afterAll(() => server.close());

  const provider = () =>
    new OpenMeteoWeatherProvider({ geocodingUrl: `${base}/geo`, forecastUrl: `${base}/forecast` });

  it("geocodes a name and returns a card-ready forecast", async () => {
    mode = "ok";
    seen.length = 0;
    const forecast = await provider().forecast({ location: "Lisbon", days: 6 }, context);
    expect(seen[0]).toContain("name=Lisbon");
    expect(seen[1]).toContain("latitude=38.72");
    expect(seen[1]).toContain("forecast_days=6");
    // Only the place name and coordinates leave: no identifiers in either request.
    expect(seen.join(" ")).not.toMatch(/user|bot|key/i);
    expect(forecast.locationLabel).toBe("Lisbon, Portugal");
    expect(forecast.timeZone).toBe("Europe/Rome");
    expect(forecast.current).toMatchObject({ code: 0, isDay: true, humidity: 68 });
    expect(forecast.days).toHaveLength(6);
    // Past hours are dropped: the strip starts with the hour in progress.
    expect(forecast.hours[0]?.startMs).toBeLessThanOrEqual(forecast.asOfMs);
    expect((forecast.hours[0]?.startMs ?? 0) + 3_600_000).toBeGreaterThan(forecast.asOfMs);
    expect(forecast.hours.length).toBeLessThanOrEqual(48);
    expect(forecast.attribution.name).toBe("Open-Meteo");
  });

  it("skips geocoding for coordinates and labels them", async () => {
    mode = "ok";
    seen.length = 0;
    const forecast = await provider().forecast({ latitude: -33.87, longitude: 151.21 }, context);
    expect(seen).toHaveLength(1);
    expect(forecast.locationLabel).toBe("-33.87, 151.21");
    expect(seen[0]).toContain("forecast_days=7");
  });

  it("keeps a full run of hours for a one-day forecast and refuses mixed input", async () => {
    mode = "ok";
    seen.length = 0;
    const forecast = await provider().forecast({ location: "Lisbon", days: 1 }, context);
    expect(seen[1]).toContain("forecast_days=2");
    expect(forecast.days).toHaveLength(1);
    expect(forecast.hours.length).toBeGreaterThan(24);
    await expect(
      provider().forecast({ location: "Lisbon", latitude: -33.87, longitude: 151.21 }, context),
    ).rejects.toThrow(/not both/);
  });

  it("explains an unknown place, bad coordinates and a missing location", async () => {
    mode = "ok";
    await expect(provider().forecast({ location: "Nowhereville" }, context)).rejects.toThrow(
      /No place named "Nowhereville"/,
    );
    await expect(provider().forecast({ latitude: 95, longitude: 0 }, context)).rejects.toThrow(
      /latitude must be/,
    );
    await expect(provider().forecast({ latitude: 10 }, context)).rejects.toThrow(
      /latitude must be/,
    );
    await expect(provider().forecast({}, context)).rejects.toThrow(/location name/);
  });

  it("reports a provider that is down, unreachable or answers nonsense", async () => {
    mode = "down";
    await expect(provider().forecast({ location: "Lisbon" }, context)).rejects.toThrow(/503/);
    mode = "garbage";
    await expect(provider().forecast({ location: "Lisbon" }, context)).rejects.toThrow(
      /could not be read/,
    );
    mode = "ok";
    const unreachable = new OpenMeteoWeatherProvider({
      geocodingUrl: "http://127.0.0.1:9/geo",
      timeoutMs: 500,
    });
    await expect(unreachable.forecast({ location: "x" }, context)).rejects.toThrow(
      /could not be reached/,
    );
  });

  it("keeps a very long place name short in the error", async () => {
    mode = "ok";
    await expect(
      provider().forecast({ location: "Nowhereville".repeat(500) }, context),
    ).rejects.toSatisfy((error: Error) => error.message.length < 200);
  });

  it("clamps the day count", () => {
    expect(clampWeatherDays(undefined)).toBe(7);
    expect(clampWeatherDays(0)).toBe(1);
    expect(clampWeatherDays(99)).toBe(10);
    expect(clampWeatherDays(Number.NaN)).toBe(7);
    expect(clampWeatherDays(3.6)).toBe(4);
  });
});
