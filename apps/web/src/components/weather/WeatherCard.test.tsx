// @vitest-environment jsdom

import type { WeatherForecast } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WeatherCard } from "./WeatherCard";

// The Lingui macro compiles a template into a message with named values; fill them in.
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (
      source: TemplateStringsArray | { message: string; values?: Record<string, unknown> },
      ...values: unknown[]
    ) =>
      "message" in source
        ? source.message.replace(/\{(\w+)\}/g, (_, key) => String(source.values?.[key]))
        : String.raw({ raw: source }, ...values),
    i18n: { locale: "en" },
  }),
}));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const asOfMs = Date.UTC(2026, 0, 15, 8, 31);

function forecast(days: number): WeatherForecast {
  return {
    locationLabel: "Lisbon, Portugal",
    timeZone: "UTC",
    asOfMs,
    current: { code: 0, isDay: true, temperatureC: 8, apparentC: 7.6, humidity: 68, windKph: 12 },
    hours: Array.from({ length: 6 }, (_, i) => ({
      startMs: Math.floor(asOfMs / HOUR) * HOUR + i * HOUR,
      code: 0,
      isDay: true,
      temperatureC: 8,
      precipChance: 0,
    })),
    days: Array.from({ length: days }, (_, i) => ({
      startMs: Math.floor(asOfMs / DAY) * DAY + i * DAY,
      code: i === 2 ? 61 : 0,
      maxC: 9,
      minC: 4,
      precipChance: i === 2 ? 45 : 5,
      precipMm: 0,
    })),
    attribution: { name: "Weather data", url: "https://example.test/weather" },
  };
}

beforeEach(() => {
  vi.spyOn(navigator, "language", "get").mockReturnValue("en-GB");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.replaceChildren();
});

function render(value: WeatherForecast) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  act(() => createRoot(host).render(<WeatherCard forecast={value} />));
  return host;
}

it("shows the headline, hourly strip, five days and the footer", () => {
  const card = render(forecast(7));
  const text = card.textContent ?? "";
  expect(text).toContain("Lisbon, Portugal");
  expect(text).toContain("8°");
  expect(text).toContain("Clear");
  expect(text).toContain("Feels like 8° · H:9° L:4°");
  expect(text).toContain("Wind 12 km/h · Humidity 68%");
  expect(text).toContain("Now");
  expect(text).toContain("Today");
  expect(card.querySelectorAll("[data-today]")).toHaveLength(1);
  // Only the rain day earns a percentage; five of seven days show.
  expect(text).toContain("45%");
  expect(card.querySelectorAll("section li")).toHaveLength(6 + 5);
  expect(text).toContain("Show more");
  expect(text).toContain("Updated 8:31 AM");
  const link = card.querySelector("a");
  expect(link?.getAttribute("href")).toBe("https://example.test/weather");
  expect(link?.getAttribute("rel")).toContain("noopener");
});

it("expands to every day and has no toggle for a short forecast", () => {
  const card = render(forecast(7));
  const more = [...card.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Show more"),
  );
  act(() => more?.click());
  expect(card.querySelectorAll("section li")).toHaveLength(6 + 7);
  expect(card.textContent).toContain("Show less");
  const short = render(forecast(3));
  expect(short.textContent).not.toContain("Show more");
});

it("switches units from a pick and remembers it", () => {
  const card = render(forecast(3));
  const fahrenheit = card.querySelector('button[aria-label="Fahrenheit"]');
  act(() => (fahrenheit as HTMLButtonElement).click());
  expect(card.textContent).toContain("46°");
  expect(card.textContent).toContain("7 mph");
  expect(localStorage.getItem("rakazo.weatherScale")).toBe("fahrenheit");
});

it("draws a link-less attribution when the address is not https", () => {
  const value = forecast(2);
  value.attribution.url = "javascript:alert(1)";
  const card = render(value);
  expect(card.querySelector("a")).toBeNull();
  expect(card.textContent).toContain("Weather data");
});
