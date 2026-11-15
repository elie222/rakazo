import type { PlacesProvider } from "@rakazo/adapter-kit";
import { FakePlacesProvider } from "./fake-places.js";
import { NominatimPlacesProvider } from "./nominatim-places.js";

/**
 * Nominatim is the keyless default; PLACES_PROVIDER=fake serves fixed places for tests. Web map
 * tiles stay off until PLACES_TILE_URL is set.
 */
export function createPlacesProvider(source: NodeJS.ProcessEnv = process.env): PlacesProvider {
  const kind = source.PLACES_PROVIDER?.trim().toLowerCase();
  switch (kind) {
    case "fake":
      return new FakePlacesProvider();
    case undefined:
    case "":
    case "nominatim":
      return new NominatimPlacesProvider({
        searchUrl: source.PLACES_NOMINATIM_URL?.trim() || undefined,
        tileUrl: source.PLACES_TILE_URL?.trim() || undefined,
        tileAttribution: source.PLACES_TILE_ATTRIBUTION?.trim() || undefined,
        contact: source.PLACES_CONTACT?.trim() || undefined,
      });
    default:
      throw new Error(`Unknown places provider "${kind}"`);
  }
}
