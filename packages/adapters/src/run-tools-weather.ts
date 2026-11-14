import type { MessageBlock, WeatherForecast } from "@rakazo/contracts";
import { weatherCondition, weatherToday } from "@rakazo/core";
import type { RunContext } from "./run-context.js";
import { publishMessage } from "./run-messages.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { argumentGiven } from "./update-bot-patch.js";

const CONDITION_WORDS = {
  clear: "clear",
  mostlyClear: "mostly clear",
  partlyCloudy: "partly cloudy",
  cloudy: "cloudy",
  fog: "foggy",
  drizzle: "drizzle",
  rain: "rain",
  freezingRain: "freezing rain",
  snow: "snow",
  showers: "rain showers",
  snowShowers: "snow showers",
  thunderstorm: "thunderstorms",
} as const;

const word = (code: number) => CONDITION_WORDS[weatherCondition(code)];

/** What the bot reads back: enough to answer in a sentence while the card carries the detail. */
function summary(forecast: WeatherForecast) {
  const today = weatherToday(forecast);
  const { current } = forecast;
  return {
    location: forecast.locationLabel,
    now: {
      condition: word(current.code),
      temperatureC: Math.round(current.temperatureC),
      feelsLikeC: Math.round(current.apparentC),
      humidityPercent: Math.round(current.humidity),
      windKph: Math.round(current.windKph),
    },
    ...(today
      ? {
          today: {
            highC: Math.round(today.maxC),
            lowC: Math.round(today.minC),
            precipitationChancePercent: Math.round(today.precipChance),
          },
        }
      : {}),
    days: forecast.days.slice(0, 7).map((day) => ({
      date: new Intl.DateTimeFormat("en-CA", { timeZone: forecast.timeZone }).format(day.startMs),
      condition: word(day.code),
      highC: Math.round(day.maxC),
      lowC: Math.round(day.minC),
      precipitationChancePercent: Math.round(day.precipChance),
    })),
  };
}

function numberArg(value: unknown): number | undefined {
  if (!argumentGiven(value)) return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : Number.NaN;
}

async function weatherForecast(ctx: RunContext, call: ToolCall) {
  const { args } = call;
  const location = argumentGiven(args.location) ? String(args.location).slice(0, 200) : undefined;
  const latitude = numberArg(args.latitude);
  const longitude = numberArg(args.longitude);
  const days = numberArg(args.days);
  let forecast: WeatherForecast;
  try {
    forecast = await ctx.providers.weather.forecast(
      { location, latitude, longitude, days, signal: ctx.context.signal },
      ctx.context,
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const block: MessageBlock = { kind: "weather", forecast };
  try {
    await publishMessage(ctx.deps, ctx.run, "bot", [block]);
  } catch {
    // The card is a courtesy; the bot can still answer from the numbers below.
    return { ...summary(forecast), note: "The weather card could not be shown; answer in words." };
  }
  return {
    ...summary(forecast),
    note: "A weather card with the hourly and daily forecast is now shown in the chat. Reply in one or two short sentences and do not repeat the numbers it shows.",
  };
}

export const weatherTools: ToolHandlers = {
  async weather_forecast(ctx, call) {
    return call.finish(await weatherForecast(ctx, call));
  },
};
