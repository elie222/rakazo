import type { PlacesPoint, PlacesViewport } from "@rakazo/core";
import { viewportCentre } from "@rakazo/core";

/** Closest a card's map zooms in, so a single place still shows its street. */
const MAX_CARD_ZOOM = 17;
/** expo-maps' zoom runs about a step behind a 256px tile map at the same number. */
export const NATIVE_ZOOM_OFFSET = 1;

/** The native map camera for a viewport: its centre and zoom. */
export function cameraFromViewport(view: PlacesViewport): {
  coordinates: PlacesPoint;
  zoom: number;
} {
  return {
    coordinates: viewportCentre(view),
    zoom: Math.min(view.zoom, MAX_CARD_ZOOM) + NATIVE_ZOOM_OFFSET,
  };
}

/** Whether distances read in miles: the device's measurement system, else its region. */
export function prefersMiles(
  locale: { measurementSystem?: string | null; languageTag?: string | null } | undefined,
  usesMiles: (tag: string | undefined) => boolean,
): boolean {
  if (locale?.measurementSystem) return locale.measurementSystem !== "metric";
  return usesMiles(locale?.languageTag ?? undefined);
}
