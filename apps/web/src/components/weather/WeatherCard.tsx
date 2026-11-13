import { useLingui } from "@lingui/react/macro";
import type { WeatherForecast } from "@rakazo/contracts";
import type { WeatherBand, WeatherConditionKey, WeatherIcon, WeatherScale } from "@rakazo/core";
import {
  weatherCanExpand,
  weatherCondition,
  weatherFillStops,
  weatherHourlyWindow,
  weatherIcon,
  weatherPrecipLikely,
  weatherRangeFill,
  weatherTemperature,
  weatherToday,
  weatherVisibleDays,
  weatherWind,
} from "@rakazo/core";
import {
  ChevronDown,
  ChevronUp,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  Moon,
  Sun,
} from "lucide-react";
import { useState } from "react";
import { setWeatherScale, useWeatherScale } from "../../lib/weather-scale";

const ICONS: Record<WeatherIcon, typeof Sun> = {
  sun: Sun,
  moon: Moon,
  "cloud-sun": CloudSun,
  "cloud-moon": CloudMoon,
  cloud: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  snow: CloudSnow,
  lightning: CloudLightning,
};

const ICON_TONE: Record<WeatherIcon, string> = {
  sun: "text-warning",
  moon: "text-muted-foreground",
  "cloud-sun": "text-warning",
  "cloud-moon": "text-muted-foreground",
  cloud: "text-muted-foreground",
  fog: "text-muted-foreground",
  drizzle: "text-link",
  rain: "text-link",
  snow: "text-link",
  lightning: "text-warning",
};

const BAND_FROM: Record<WeatherBand, string> = {
  blue: "from-link",
  cyan: "from-link",
  green: "from-success",
  yellow: "from-warning",
  orange: "from-warning",
  red: "from-destructive",
};
const BAND_VIA: Record<WeatherBand, string> = {
  blue: "via-link",
  cyan: "via-link",
  green: "via-success",
  yellow: "via-warning",
  orange: "via-warning",
  red: "via-destructive",
};
const BAND_TO: Record<WeatherBand, string> = {
  blue: "to-link",
  cyan: "to-link",
  green: "to-success",
  yellow: "to-warning",
  orange: "to-warning",
  red: "to-destructive",
};

function useConditionLabel() {
  const { t } = useLingui();
  const labels: Record<WeatherConditionKey, string> = {
    clear: t`Clear`,
    mostlyClear: t`Mostly clear`,
    partlyCloudy: t`Partly cloudy`,
    cloudy: t`Cloudy`,
    fog: t`Fog`,
    drizzle: t`Drizzle`,
    rain: t`Rain`,
    freezingRain: t`Freezing rain`,
    snow: t`Snow`,
    showers: t`Showers`,
    snowShowers: t`Snow showers`,
    thunderstorm: t`Thunderstorms`,
  };
  return (code: number) => labels[weatherCondition(code)];
}

function Glyph({ code, isDay, className }: { code: number; isDay: boolean; className: string }) {
  const icon = weatherIcon(code, isDay);
  const Icon = ICONS[icon];
  return <Icon aria-hidden="true" className={`shrink-0 ${ICON_TONE[icon]} ${className}`} />;
}

function UnitToggle({ scale }: { scale: WeatherScale }) {
  const { t } = useLingui();
  const options: [WeatherScale, string, string][] = [
    ["fahrenheit", "°F", t`Fahrenheit`],
    ["celsius", "°C", t`Celsius`],
  ];
  return (
    <fieldset
      aria-label={t`Temperature unit`}
      className="m-0 flex min-w-0 rounded-full border-0 bg-muted p-0.5"
    >
      {options.map(([value, label, name]) => (
        <button
          key={value}
          type="button"
          aria-pressed={scale === value}
          aria-label={name}
          onClick={() => setWeatherScale(value)}
          className="rounded-full px-2.5 py-0.5 text-body text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-sm"
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
}

function RangeBar({
  days,
  day,
}: {
  days: WeatherForecast["days"];
  day: WeatherForecast["days"][number];
}) {
  const { start, end } = weatherRangeFill(days, day);
  const stops = weatherFillStops(day.minC, day.maxC);
  const first = stops[0]?.band ?? "blue";
  const last = stops.at(-1)?.band ?? first;
  const middle = stops[Math.floor(stops.length / 2)]?.band ?? first;
  return (
    // The track mirrors in right-to-left languages, so low temperatures sit at the start.
    <div
      aria-hidden="true"
      className="relative hidden h-1 min-w-4 flex-1 rounded-full @min-[13rem]:block bg-foreground/10 rtl:-scale-x-100"
    >
      <div
        className={`absolute inset-y-0 rounded-full bg-linear-to-r ${BAND_FROM[first]} ${BAND_VIA[middle]} ${BAND_TO[last]}`}
        style={{
          left: `${start * 100}%`,
          width: `${Math.max((end - start) * 100, 4)}%`,
        }}
      />
    </div>
  );
}

/** A forecast the bot looked up: now, the next hours, and the days ahead. */
export function WeatherCard({ forecast }: { forecast: WeatherForecast }) {
  const { t, i18n } = useLingui();
  const label = useConditionLabel();
  const scale = useWeatherScale();
  const [expanded, setExpanded] = useState(false);
  const locale = i18n.locale || "en";
  const { current, timeZone } = forecast;
  const deg = (celsius: number) => `${weatherTemperature(celsius, scale)}°`;
  const hourFormat = new Intl.DateTimeFormat(locale, { hour: "numeric", timeZone });
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone });
  const updated = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(forecast.asOfMs);
  const today = weatherToday(forecast);
  const feelsLike = deg(current.apparentC);
  const high = today ? deg(today.maxC) : "";
  const low = today ? deg(today.minC) : "";
  const wind = weatherWind(current.windKph, scale);
  const windText = `${wind.value} ${wind.unit === "mph" ? t`mph` : t`km/h`}`;
  const humidity = new Intl.NumberFormat(locale, { style: "percent" }).format(
    current.humidity / 100,
  );
  const hours = weatherHourlyWindow(forecast);
  const days = weatherVisibleDays(forecast.days, expanded);
  const percent = (value: number) =>
    new Intl.NumberFormat(locale, { style: "percent" }).format(value / 100);
  const attributionHref = forecast.attribution.url.startsWith("https://")
    ? forecast.attribution.url
    : undefined;
  return (
    <section
      data-testid="weather-card"
      aria-label={forecast.locationLabel}
      className="@container w-full max-w-[561px] rounded-[24px] bg-card px-5 py-4 text-foreground ring-[0.5px] ring-border"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="min-w-0 truncate font-semibold text-body-lg">{forecast.locationLabel}</h3>
        <UnitToggle scale={scale} />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Glyph code={current.code} isDay={current.isDay} className="size-11" />
        <span className="font-medium text-display">{deg(current.temperatureC)}</span>
        <span className="font-medium text-body-lg">{label(current.code)}</span>
      </div>
      <div className="mt-2 space-y-0.5 text-body text-muted-foreground">
        <p>
          {today ? t`Feels like ${feelsLike} · H:${high} L:${low}` : t`Feels like ${feelsLike}`}
        </p>
        <p>{t`Wind ${windText} · Humidity ${humidity}`}</p>
      </div>
      {hours.length > 0 ? (
        <div className="mt-4 border-t border-foreground/[0.06] pt-3">
          <h4 className="mb-2 text-body text-muted-foreground">{t`Hourly forecast`}</h4>
          <ul className="-mx-1 flex gap-1 overflow-x-auto pb-1">
            {hours.map((hour) => (
              <li
                key={hour.startMs}
                className="flex w-12 shrink-0 flex-col items-center gap-1 text-body"
              >
                <span className="whitespace-nowrap text-muted-foreground">
                  {hour.now ? t`Now` : hourFormat.format(hour.startMs)}
                </span>
                <Glyph code={hour.code} isDay={hour.isDay} className="size-6" />
                <span>{deg(hour.temperatureC)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-3 border-t border-foreground/[0.06] pt-3">
        <h4 className="mb-1 text-body text-muted-foreground">{t`Daily forecast`}</h4>
        <ul>
          {days.map((day) => {
            const isToday = day === today;
            return (
              <li
                key={day.startMs}
                data-today={isToday || undefined}
                className="flex h-11 items-center gap-2 rounded-xl px-2 @max-[13rem]:gap-1 @max-[13rem]:px-1 text-body data-today:bg-foreground/[0.06]"
              >
                <span className="w-10 shrink-0 truncate">
                  {isToday ? t`Today` : weekdayFormat.format(day.startMs)}
                </span>
                <span className="flex w-8 shrink-0 flex-col items-center leading-none">
                  <Glyph code={day.code} isDay className="size-5" />
                  {weatherPrecipLikely(day) ? (
                    <span className="mt-0.5 text-caption text-link">
                      {percent(day.precipChance)}
                    </span>
                  ) : null}
                </span>
                <span className="ms-auto w-8 shrink-0 text-end @max-[13rem]:w-auto text-muted-foreground @min-[13rem]:ms-0">
                  {deg(day.minC)}
                </span>
                <RangeBar days={forecast.days} day={day} />
                <span className="w-8 shrink-0 @max-[13rem]:w-auto">{deg(day.maxC)}</span>
              </li>
            );
          })}
        </ul>
        {weatherCanExpand(forecast.days) ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="mt-1 flex items-center gap-1 rounded-md px-2 py-1 text-body text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expanded ? t`Show less` : t`Show more`}
            {expanded ? (
              <ChevronUp aria-hidden="true" className="size-4" />
            ) : (
              <ChevronDown aria-hidden="true" className="size-4" />
            )}
          </button>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-foreground/[0.06] pt-3 text-body text-muted-foreground">
        {attributionHref ? (
          <a
            href={attributionHref}
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 hover:underline"
          >
            {forecast.attribution.name}
          </a>
        ) : (
          <span>{forecast.attribution.name}</span>
        )}
        <span className="shrink-0">{t`Updated ${updated}`}</span>
      </div>
    </section>
  );
}
