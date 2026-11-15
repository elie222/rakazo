import type { PlacesCard } from "@rakazo/contracts";

export type PlacesPoint = { latitude: number; longitude: number };
export type PlacesItem = PlacesCard["places"][number];

/** Zoom limits for a card's map. */
export const PLACES_MIN_ZOOM = 2;
export const PLACES_MAX_ZOOM = 17;
const TILE = 256;

/** Great-circle distance between two points in whole metres. */
export function distanceMeters(a: PlacesPoint, b: PlacesPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** "450 m" or "1.2 km"; miles when `imperial`, as "0.3 mi" or "2.1 mi". */
export function formatDistance(meters: number, imperial: boolean, locale?: string): string {
  const number = (value: number, digits: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  if (imperial) {
    const miles = meters / 1609.344;
    return `${number(miles, miles < 10 ? 1 : 0)} mi`;
  }
  if (meters < 1000) return `${number(Math.round(meters / 10) * 10 || meters, 0)} m`;
  const km = meters / 1000;
  return `${number(km, km < 10 ? 1 : 0)} km`;
}

/** The countries that still show distances in miles. */
export function usesMiles(locale: string | undefined): boolean {
  const region = locale?.split(/[-_]/)[1]?.toUpperCase();
  return region === "US" || region === "GB" || region === "LR" || region === "MM";
}

/** Longitude and latitude as fractional tile coordinates at a zoom (Web Mercator). */
export function tileCoordinates(point: PlacesPoint, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const lat = Math.max(-85.0511, Math.min(85.0511, point.latitude));
  const rad = (lat * Math.PI) / 180;
  return {
    x: ((point.longitude + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  };
}

export type PlacesViewport = {
  zoom: number;
  /** The centre, as fractional tile coordinates at `zoom`. */
  centerX: number;
  centerY: number;
};

/**
 * The most zoomed-in view that shows every place inside a frame, with `padding` pixels kept
 * clear. Places across the date line are fitted around the shorter way.
 */
export function fitViewport(
  places: readonly PlacesPoint[],
  width: number,
  height: number,
  padding = 28,
): PlacesViewport {
  if (places.length === 0) return { zoom: PLACES_MIN_ZOOM, centerX: 2, centerY: 2 };
  const lons = places.map((place) => place.longitude);
  const direct = Math.max(...lons) - Math.min(...lons);
  // Shifting western longitudes east by 360 closes a gap that spans the date line.
  const wrapped = places.map((place) =>
    direct > 180 && place.longitude < 0 ? place.longitude + 360 : place.longitude,
  );
  const shifted = places.map((place, index) => ({
    latitude: place.latitude,
    longitude: wrapped[index] ?? place.longitude,
  }));
  const availableW = Math.max(width - padding * 2, 1);
  const availableH = Math.max(height - padding * 2, 1);
  let zoom = PLACES_MAX_ZOOM;
  for (; zoom > PLACES_MIN_ZOOM; zoom -= 1) {
    const tiles = shifted.map((point) => tileCoordinates(point, zoom));
    const xs = tiles.map((tile) => tile.x);
    const ys = tiles.map((tile) => tile.y);
    const spanX = (Math.max(...xs) - Math.min(...xs)) * TILE;
    const spanY = (Math.max(...ys) - Math.min(...ys)) * TILE;
    if (spanX <= availableW && spanY <= availableH) break;
  }
  const tiles = shifted.map((point) => tileCoordinates(point, zoom));
  const xs = tiles.map((tile) => tile.x);
  const ys = tiles.map((tile) => tile.y);
  return {
    zoom,
    centerX: (Math.max(...xs) + Math.min(...xs)) / 2,
    centerY: (Math.max(...ys) + Math.min(...ys)) / 2,
  };
}

/** A viewport centred on one point at a zoom. */
export function viewportAt(point: PlacesPoint, zoom: number): PlacesViewport {
  const tile = tileCoordinates(point, zoom);
  return { zoom, centerX: tile.x, centerY: tile.y };
}

/** The map point (degrees) at a viewport's centre. */
export function viewportCentre(view: PlacesViewport): PlacesPoint {
  const n = 2 ** view.zoom;
  const latitude = (Math.atan(Math.sinh(Math.PI * (1 - (2 * view.centerY) / n))) * 180) / Math.PI;
  // Places fitted across the date line centre past 180 degrees; wrap back into range.
  const longitude = (((((view.centerX / n) * 360) % 360) + 360) % 360) - 180;
  return { latitude, longitude };
}

/** Pins that sit closer together than a pin is wide, drawn as one counted bubble. */
export type PlacesCluster<T extends PlacesPoint & { id: string }> = {
  /** The place's own id for a single pin, `group:` plus the first member's id for a group. */
  id: string;
  members: T[];
  latitude: number;
  longitude: number;
};

/**
 * Merges places whose pins would be closer than `minDistancePx` at a zoom (256px tiles), in list
 * order, so a crowded map shows counted groups instead of a stack of overlapping pins. Zooming in
 * pulls groups apart; places at the very same spot stay together at any zoom.
 */
export function clusterPlaces<T extends PlacesPoint & { id: string }>(
  places: readonly T[],
  zoom: number,
  minDistancePx = 30,
): PlacesCluster<T>[] {
  const n = 2 ** zoom;
  type Group = { members: { place: T; index: number }[]; x: number; y: number };
  const groups: Group[] = [];
  // The shorter way round the world keeps date-line neighbours together.
  const wrapDx = (dx: number) => (dx > n / 2 ? dx - n : dx < -n / 2 ? dx + n : dx);
  const apart = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(wrapDx(b.x - a.x) * TILE, (b.y - a.y) * TILE);
  const absorb = (group: Group, members: Group["members"], x: number, y: number) => {
    const total = group.members.length + members.length;
    const dx = wrapDx(x - group.x);
    group.x = (group.x * group.members.length + (group.x + dx) * members.length) / total;
    group.y = (group.y * group.members.length + y * members.length) / total;
    group.members.push(...members);
  };
  places.forEach((place, index) => {
    const tile = tileCoordinates(place, zoom);
    const home = groups.find((group) => apart(group, tile) < minDistancePx);
    if (home) absorb(home, [{ place, index }], tile.x, tile.y);
    else groups.push({ members: [{ place, index }], x: tile.x, y: tile.y });
  });
  // A group's centre moves as it grows, so merge any groups that ended up too close, until none are.
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < groups.length && !merged; i += 1) {
      for (let j = i + 1; j < groups.length && !merged; j += 1) {
        const first = groups[i] as Group;
        const second = groups[j] as Group;
        if (apart(first, second) < minDistancePx) {
          absorb(first, second.members, second.x, second.y);
          groups.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  return groups
    .map((group) => ({
      ...group,
      members: group.members.sort((a, b) => a.index - b.index),
    }))
    .sort((a, b) => (a.members[0]?.index ?? 0) - (b.members[0]?.index ?? 0))
    .map((group) => {
      const members = group.members.map((member) => member.place);
      const first = members[0] as T;
      if (members.length === 1) {
        return { id: first.id, members, latitude: first.latitude, longitude: first.longitude };
      }
      const centre = viewportCentre({ zoom, centerX: group.x, centerY: group.y });
      return { id: `group:${first.id}`, members, ...centre };
    });
}

/** Where a place sits in a frame, in pixels from its top-left corner. */
export function projectToFrame(
  point: PlacesPoint,
  viewport: PlacesViewport,
  width: number,
  height: number,
): { left: number; top: number } {
  const n = 2 ** viewport.zoom;
  const tile = tileCoordinates(point, viewport.zoom);
  // Pick the copy of the world nearest the centre, so date-line neighbours stay together.
  let dx = tile.x - viewport.centerX;
  if (dx > n / 2) dx -= n;
  else if (dx < -n / 2) dx += n;
  return {
    left: width / 2 + dx * TILE,
    top: height / 2 + (tile.y - viewport.centerY) * TILE,
  };
}

export type PlacesTile = { key: string; url: string; left: number; top: number };

/** The tiles that cover a frame, positioned in pixels from its top-left corner. */
export function frameTiles(
  template: string,
  viewport: PlacesViewport,
  width: number,
  height: number,
): PlacesTile[] {
  const n = 2 ** viewport.zoom;
  const originX = viewport.centerX * TILE - width / 2;
  const originY = viewport.centerY * TILE - height / 2;
  const firstX = Math.floor(originX / TILE);
  const lastX = Math.floor((originX + width) / TILE);
  const firstY = Math.max(0, Math.floor(originY / TILE));
  const lastY = Math.min(n - 1, Math.floor((originY + height) / TILE));
  const tiles: PlacesTile[] = [];
  for (let ty = firstY; ty <= lastY; ty += 1) {
    for (let tx = firstX; tx <= lastX; tx += 1) {
      const wrappedX = ((tx % n) + n) % n;
      tiles.push({
        key: `${viewport.zoom}/${tx}/${ty}`,
        url: template
          .replace("{z}", String(viewport.zoom))
          .replace("{x}", String(wrappedX))
          .replace("{y}", String(ty)),
        left: tx * TILE - originX,
        top: ty * TILE - originY,
      });
    }
  }
  return tiles;
}

/** A link that opens a place in the platform's maps app. */
export function placeMapsUrl(
  place: Pick<PlacesItem, "name" | "latitude" | "longitude">,
  platform: "apple" | "web",
): string {
  const lat = place.latitude.toFixed(6);
  const lon = place.longitude.toFixed(6);
  if (platform === "apple") {
    return `https://maps.apple.com/?ll=${lat},${lon}&q=${encodeURIComponent(place.name)}`;
  }
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
}
