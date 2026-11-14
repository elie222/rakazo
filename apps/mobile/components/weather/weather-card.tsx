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
import { useState } from "react";
import { I18nManager, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { dateLocaleForUi, useUiLocale } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { setWeatherScale, useWeatherScale } from "../../lib/weather-scale";
import { NativeSegmentedControl } from "../native-segmented-control";
import { NativeSymbol } from "../native-symbol";

type Tokens = ReturnType<typeof useMobileTokens>;

const SYMBOLS: Record<WeatherIcon, { ios: string; android: string }> = {
  sun: { ios: "sun.max.fill", android: "sunny" },
  moon: { ios: "moon.fill", android: "moon" },
  "cloud-sun": { ios: "cloud.sun.fill", android: "partly-sunny" },
  "cloud-moon": { ios: "cloud.moon.fill", android: "cloudy-night" },
  cloud: { ios: "cloud.fill", android: "cloud" },
  fog: { ios: "cloud.fog.fill", android: "cloud" },
  drizzle: { ios: "cloud.drizzle.fill", android: "rainy" },
  rain: { ios: "cloud.rain.fill", android: "rainy" },
  snow: { ios: "cloud.snow.fill", android: "snow" },
  lightning: { ios: "cloud.bolt.fill", android: "thunderstorm" },
};

function iconColor(icon: WeatherIcon, tokens: Tokens): string {
  switch (icon) {
    case "sun":
    case "cloud-sun":
    case "lightning":
      return tokens.warning;
    case "drizzle":
    case "rain":
    case "snow":
      return tokens.link;
    default:
      return tokens.mutedForeground;
  }
}

function bandColor(band: WeatherBand, tokens: Tokens): string {
  switch (band) {
    case "blue":
    case "cyan":
      return tokens.link;
    case "green":
      return tokens.success;
    case "yellow":
    case "orange":
      return tokens.warning;
    case "red":
      return tokens.destructive;
  }
}

function Glyph({
  code,
  isDay,
  size,
  tokens,
}: {
  code: number;
  isDay: boolean;
  size: number;
  tokens: Tokens;
}) {
  const icon = weatherIcon(code, isDay);
  const symbol = SYMBOLS[icon];
  return (
    <NativeSymbol
      ios={symbol.ios}
      android={symbol.android as never}
      size={size}
      color={iconColor(icon, tokens)}
    />
  );
}

function RangeBar({
  days,
  day,
  tokens,
}: {
  days: WeatherForecast["days"];
  day: WeatherForecast["days"][number];
  tokens: Tokens;
}) {
  const { start, end } = weatherRangeFill(days, day);
  const stops = weatherFillStops(day.minC, day.maxC);
  const rtl = I18nManager.isRTL;
  const id = `fill-${day.startMs}`;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.track, { backgroundColor: `${tokens.foreground}1A` }]}
    >
      <View
        style={[
          styles.fill,
          { start: `${start * 100}%`, width: `${Math.max((end - start) * 100, 4)}%` },
        ]}
      >
        <Svg width="100%" height="100%" preserveAspectRatio="none">
          <Defs>
            <LinearGradient id={id} x1={rtl ? "1" : "0"} y1="0" x2={rtl ? "0" : "1"} y2="0">
              {stops.map((stop) => (
                <Stop
                  key={`${stop.at}-${stop.band}`}
                  offset={`${stop.at}`}
                  stopColor={bandColor(stop.band, tokens)}
                />
              ))}
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" rx={2} fill={`url(#${id})`} />
        </Svg>
      </View>
    </View>
  );
}

/** A forecast the bot looked up: now, the next hours, and the days ahead. */
export function WeatherCard({ forecast }: { forecast: WeatherForecast }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const scale = useWeatherScale();
  const uiLocale = useUiLocale();
  const [expanded, setExpanded] = useState(false);
  const locale = dateLocaleForUi(uiLocale);
  const { current, timeZone } = forecast;
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
  const label = (code: number) => labels[weatherCondition(code)];
  const deg = (celsius: number) => `${weatherTemperature(celsius, scale)}°`;
  const hourFormat = new Intl.DateTimeFormat(locale, { hour: "numeric", timeZone });
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone });
  const updated = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(forecast.asOfMs);
  const percent = (value: number) =>
    new Intl.NumberFormat(locale, { style: "percent" }).format(value / 100);
  const today = weatherToday(forecast);
  const feelsLike = deg(current.apparentC);
  const high = today ? deg(today.maxC) : "";
  const low = today ? deg(today.minC) : "";
  const wind = weatherWind(current.windKph, scale);
  const windText = `${wind.value} ${wind.unit === "mph" ? t`mph` : t`km/h`}`;
  const humidity = percent(current.humidity);
  const hours = weatherHourlyWindow(forecast);
  const days = weatherVisibleDays(forecast.days, expanded);
  const attributionUrl = forecast.attribution.url.startsWith("https://")
    ? forecast.attribution.url
    : undefined;
  const divider = { borderTopColor: `${tokens.foreground}0F` };
  const units: [WeatherScale, string][] = [
    ["fahrenheit", "°F"],
    ["celsius", "°C"],
  ];
  return (
    <View
      testID="weather-card"
      accessible={false}
      accessibilityLabel={forecast.locationLabel}
      style={[styles.card, { backgroundColor: tokens.card, borderColor: `${tokens.foreground}1F` }]}
    >
      <View style={styles.header}>
        <Text
          numberOfLines={1}
          accessibilityRole="header"
          style={[styles.location, { color: tokens.foreground }]}
        >
          {forecast.locationLabel}
        </Text>
        <View style={styles.toggle}>
          <NativeSegmentedControl
            accessibilityLabel={t`Temperature unit`}
            value={scale}
            onChange={setWeatherScale}
            options={units.map(([value, label]) => ({ value, label }))}
          />
        </View>
      </View>
      <View style={styles.headline}>
        <Glyph code={current.code} isDay={current.isDay} size={44} tokens={tokens} />
        <Text style={[styles.big, { color: tokens.foreground }]}>{deg(current.temperatureC)}</Text>
        <Text style={[styles.condition, { color: tokens.foreground }]}>{label(current.code)}</Text>
      </View>
      <Text style={[styles.detail, { color: tokens.mutedForeground }]}>
        {today ? t`Feels like ${feelsLike} · H:${high} L:${low}` : t`Feels like ${feelsLike}`}
      </Text>
      <Text style={[styles.detail, { color: tokens.mutedForeground }]}>
        {t`Wind ${windText} · Humidity ${humidity}`}
      </Text>
      {hours.length > 0 ? (
        <View style={[styles.section, divider]}>
          <Text style={[styles.sectionTitle, { color: tokens.mutedForeground }]}>
            {t`Hourly forecast`}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {hours.map((hour) => (
              <View key={hour.startMs} style={styles.hour}>
                <Text numberOfLines={1} style={[styles.small, { color: tokens.mutedForeground }]}>
                  {hour.now ? t`Now` : hourFormat.format(hour.startMs)}
                </Text>
                <Glyph code={hour.code} isDay={hour.isDay} size={24} tokens={tokens} />
                <Text style={[styles.small, { color: tokens.foreground }]}>
                  {deg(hour.temperatureC)}
                </Text>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}
      <View style={[styles.section, divider]}>
        <Text style={[styles.sectionTitle, { color: tokens.mutedForeground }]}>
          {t`Daily forecast`}
        </Text>
        {days.map((day) => {
          const isToday = day === today;
          return (
            <View
              key={day.startMs}
              style={[styles.day, isToday && { backgroundColor: `${tokens.foreground}0F` }]}
            >
              <Text numberOfLines={1} style={[styles.dayName, { color: tokens.foreground }]}>
                {isToday ? t`Today` : weekdayFormat.format(day.startMs)}
              </Text>
              <View style={styles.dayIcon}>
                <Glyph code={day.code} isDay size={20} tokens={tokens} />
                {weatherPrecipLikely(day) ? (
                  <Text style={[styles.precip, { color: tokens.link }]}>
                    {percent(day.precipChance)}
                  </Text>
                ) : null}
              </View>
              <Text style={[styles.temp, styles.low, { color: tokens.mutedForeground }]}>
                {deg(day.minC)}
              </Text>
              <RangeBar days={forecast.days} day={day} tokens={tokens} />
              <Text style={[styles.temp, { color: tokens.foreground }]}>{deg(day.maxC)}</Text>
            </View>
          );
        })}
        {weatherCanExpand(forecast.days) ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(!expanded)}
            style={styles.more}
          >
            <Text style={{ fontSize: 15, color: tokens.mutedForeground }}>
              {expanded ? t`Show less` : t`Show more`}
            </Text>
            <NativeSymbol
              ios={expanded ? "chevron.up" : "chevron.down"}
              android={expanded ? "chevron-up" : "chevron-down"}
              size={12}
              color={tokens.mutedForeground}
            />
          </Pressable>
        ) : null}
      </View>
      <View style={[styles.footer, divider]}>
        {attributionUrl ? (
          <Text
            accessibilityRole="link"
            numberOfLines={1}
            onPress={() => void Linking.openURL(attributionUrl)}
            style={[styles.small, { color: tokens.mutedForeground }]}
          >
            {forecast.attribution.name}
          </Text>
        ) : (
          <Text numberOfLines={1} style={[styles.small, { color: tokens.mutedForeground }]}>
            {forecast.attribution.name}
          </Text>
        )}
        <Text style={[styles.small, { color: tokens.mutedForeground }]}>
          {t`Updated ${updated}`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: "100%",
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  location: { flex: 1, fontSize: 17, lineHeight: 22, fontWeight: "600" },
  toggle: { width: 112 },
  headline: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 12 },
  big: { fontSize: 44, lineHeight: 50, fontWeight: "500" },
  condition: { fontSize: 17, fontWeight: "500" },
  detail: { fontSize: 15, lineHeight: 20, marginTop: 2 },
  section: { marginTop: 14, paddingTop: 12, borderTopWidth: 1 },
  sectionTitle: { fontSize: 15, marginBottom: 8 },
  hour: { width: 52, alignItems: "center", gap: 6 },
  small: { fontSize: 15 },
  day: {
    flexDirection: "row",
    alignItems: "center",
    height: 44,
    gap: 10,
    borderRadius: 12,
    paddingHorizontal: 8,
  },
  dayName: { width: 48, fontSize: 15 },
  dayIcon: { width: 36, alignItems: "center" },
  precip: { fontSize: 11, lineHeight: 13 },
  temp: { width: 34, fontSize: 15 },
  low: { textAlign: "right" },
  track: { flex: 1, height: 4, minWidth: 48, borderRadius: 2 },
  fill: { position: "absolute", top: 0, bottom: 0 },
  more: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
  },
});
