import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { PlacesCard as PlacesCardData } from "@rakazo/contracts";
import type { PlacesCluster, PlacesViewport } from "@rakazo/core";
import {
  clusterPlaces,
  fitViewport,
  formatDistance,
  placeMapsUrl,
  usesMiles,
  viewportAt,
} from "@rakazo/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { dateLocaleForUi, deviceLanguage, useUiLocale } from "../../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../../lib/native";
import { loadPlacesMaps } from "../../lib/places-maps";
import { cameraFromViewport, prefersMiles } from "../../lib/places-view";
import { NativeActionButton } from "../native-action-button";

const MAP_HEIGHT = 220;
/** Longest label a map pin carries; the full name stays in the list. */
const MARKER_TITLE_MAX = 32;
const markerTitle = (name: string) =>
  name.length > MARKER_TITLE_MAX ? `${name.slice(0, MARKER_TITLE_MAX - 1)}…` : name;

/** Zoom when a tapped row brings its place into view. */
const FOCUS_ZOOM = 16;
/** Closest two pins sit before they merge into one counted group, in points. */
const PIN_SPACING = 30;
/** Rows shown before "Show more". */
const COLLAPSED_ROWS = 5;

/** Whether the device shows distances in miles; kilometres until it says otherwise. */
function useMiles(): boolean {
  const [miles, setMiles] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const localization = await import("expo-localization");
        const locale = localization.getLocales()[0];
        if (live) setMiles(prefersMiles(locale, usesMiles));
      } catch {
        const tag = await deviceLanguage();
        if (live) setMiles(usesMiles(tag ?? undefined));
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return miles;
}

/** Places a bot looked up: a map when the device can draw one, and the list below it. */
export function PlacesCard({ card }: { card: PlacesCardData }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const scheme = useResolvedAppearance();
  const locale = dateLocaleForUi(useUiLocale());
  const miles = useMiles();
  const maps = loadPlacesMaps();
  const mapRef = useRef<{
    setCameraPosition: (camera: { coordinates: object; zoom: number }) => Promise<void>;
  } | null>(null);
  const { places } = card;
  const countLabel = plural(places.length, { one: "# place", other: "# places" });
  const [expanded, setExpanded] = useState(false);
  // The map shows pins for the rows on screen, grouped where they would overlap.
  const shown = useMemo(
    () => (expanded ? places : places.slice(0, COLLAPSED_ROWS)),
    [expanded, places],
  );
  const [width, setWidth] = useState<number | null>(null);
  const [focused, setFocused] = useState<PlacesViewport | null>(null);
  const fitted = useMemo(
    () => (width === null ? null : fitViewport(shown, width, MAP_HEIGHT, 56)),
    [shown, width],
  );
  // Showing more or fewer rows starts again from the fitted view.
  useEffect(() => setFocused(null), [expanded]);
  const viewport = focused ?? fitted;
  const clusters = useMemo(
    () => (viewport ? clusterPlaces(shown, viewport.zoom, PIN_SPACING) : []),
    [shown, viewport],
  );
  // The camera prop is set once; later moves go through the ref so a re-render never undoes a tap.
  const [initialCamera, setInitialCamera] = useState<ReturnType<typeof cameraFromViewport> | null>(
    null,
  );
  useEffect(() => {
    if (!viewport) return;
    setInitialCamera((current) => current ?? cameraFromViewport(viewport));
    void mapRef.current?.setCameraPosition(cameraFromViewport(viewport));
  }, [viewport]);
  const attributionUrl = card.attribution.url.startsWith("https://")
    ? card.attribution.url
    : undefined;
  const divider = { borderTopColor: `${tokens.foreground}0F` };
  const AppleMap = maps?.AppleMaps;

  const focus = (place: (typeof places)[number]) => {
    if (!AppleMap) return;
    setFocused(viewportAt(place, FOCUS_ZOOM));
  };
  const openGroup = (cluster: PlacesCluster<(typeof places)[number]>) => {
    const fit = fitViewport(cluster.members, width ?? 320, MAP_HEIGHT, 56);
    // Zoom in on the group; a group that cannot be pulled apart opens the whole list instead.
    if (viewport && fit.zoom > viewport.zoom) setFocused(fit);
    else setExpanded(true);
  };
  const number = (id: string) => places.findIndex((place) => place.id === id) + 1;

  return (
    <View
      testID="places-card"
      accessible={false}
      onLayout={(event: LayoutChangeEvent) => {
        const next = event.nativeEvent.layout.width;
        setWidth((current) => current ?? next);
      }}
      style={[styles.card, { backgroundColor: tokens.card, borderColor: `${tokens.foreground}1F` }]}
    >
      {AppleMap && maps && initialCamera ? (
        <View style={styles.map} accessibilityLabel={card.query}>
          <AppleMap.View
            ref={mapRef as never}
            style={StyleSheet.absoluteFill}
            colorScheme={
              scheme === "dark"
                ? maps.AppleMaps.MapColorScheme.DARK
                : maps.AppleMaps.MapColorScheme.LIGHT
            }
            cameraPosition={initialCamera}
            markers={clusters.map((cluster) => {
              const [only] = cluster.members;
              const grouped = cluster.members.length > 1 || !only;
              return {
                id: cluster.id,
                title:
                  grouped || !only
                    ? plural(cluster.members.length, { one: "# place", other: "# places" })
                    : markerTitle(only.name),
                monogram: grouped ? String(cluster.members.length) : String(number(cluster.id)),
                tintColor: grouped ? tokens.mutedForeground : tokens.primary,
                coordinates: { latitude: cluster.latitude, longitude: cluster.longitude },
              };
            })}
            onMarkerClick={(marker: { id?: string }) => {
              const cluster = clusters.find((entry) => entry.id === marker.id);
              if (cluster && cluster.members.length > 1) openGroup(cluster);
            }}
            uiSettings={{
              compassEnabled: false,
              myLocationButtonEnabled: false,
              togglePitchEnabled: false,
            }}
          />
          <View
            pointerEvents="none"
            style={[styles.chip, { backgroundColor: tokens.card, borderColor: tokens.border }]}
          >
            <Text style={[styles.chipText, { color: tokens.foreground }]}>{countLabel}</Text>
          </View>
        </View>
      ) : null}
      <View style={styles.body}>
        <Text
          numberOfLines={1}
          accessibilityRole="header"
          style={[styles.title, { color: tokens.foreground }]}
        >
          {AppleMap ? card.query : `${card.query} · ${countLabel}`}
        </Text>
        {shown.map((place, index) => {
          const detail = [
            place.category,
            place.distanceM === undefined
              ? undefined
              : formatDistance(place.distanceM, miles, locale),
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <View key={place.id} style={[styles.row, index > 0 && divider]}>
              <Pressable
                accessibilityRole={AppleMap ? "button" : undefined}
                disabled={!AppleMap}
                onPress={() => focus(place)}
                style={styles.rowMain}
              >
                <Text style={[styles.number, { color: tokens.mutedForeground }]}>{index + 1}</Text>
                <View style={styles.text}>
                  <Text numberOfLines={2} style={[styles.name, { color: tokens.foreground }]}>
                    {place.name}
                  </Text>
                  {detail ? (
                    <Text
                      numberOfLines={1}
                      style={[styles.detail, { color: tokens.mutedForeground }]}
                    >
                      {detail}
                    </Text>
                  ) : null}
                  {place.address ? (
                    <Text
                      numberOfLines={2}
                      style={[styles.detail, { color: tokens.mutedForeground }]}
                    >
                      {place.address}
                    </Text>
                  ) : null}
                  {place.hours ? (
                    <Text
                      numberOfLines={2}
                      style={[styles.detail, { color: tokens.mutedForeground }]}
                    >
                      {place.hours}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
              <NativeActionButton
                accessibilityLabel={t`Open in Maps`}
                prominence="plain"
                icon={{
                  ios: "arrow.triangle.turn.up.right.circle",
                  android: "navigate-circle-outline",
                  size: 24,
                }}
                onPress={() =>
                  void Linking.openURL(placeMapsUrl(place, Platform.OS === "ios" ? "apple" : "web"))
                }
              />
            </View>
          );
        })}
        {places.length > COLLAPSED_ROWS ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setExpanded((open) => !open)}
            style={[styles.more, divider]}
          >
            <Text style={[styles.moreText, { color: tokens.primary }]}>
              {expanded ? t`Show less` : t`Show more`}
            </Text>
          </Pressable>
        ) : null}
        <View style={[styles.footer, divider]}>
          {attributionUrl ? (
            <Text
              accessibilityRole="link"
              numberOfLines={1}
              onPress={() => void Linking.openURL(attributionUrl)}
              style={[styles.small, { color: tokens.mutedForeground }]}
            >
              {card.attribution.name}
            </Text>
          ) : (
            <Text numberOfLines={1} style={[styles.small, { color: tokens.mutedForeground }]}>
              {card.attribution.name}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { width: "100%", borderRadius: 24, borderWidth: 1, overflow: "hidden" },
  map: { height: MAP_HEIGHT },
  more: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 12, alignItems: "center" },
  moreText: { fontSize: 15, fontWeight: "600" },
  chip: {
    position: "absolute",
    top: 10,
    start: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipText: { fontSize: 13, fontWeight: "600" },
  body: { paddingHorizontal: 18, paddingVertical: 16 },
  title: { fontSize: 17, lineHeight: 22, fontWeight: "600", marginBottom: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "transparent",
  },
  rowMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 10,
  },
  number: { width: 20, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  text: { flex: 1, gap: 2 },
  name: { fontSize: 16, lineHeight: 21, fontWeight: "600" },
  detail: { fontSize: 14, lineHeight: 19 },
  small: { fontSize: 15 },
  footer: { marginTop: 8, paddingTop: 12, borderTopWidth: 1 },
});
