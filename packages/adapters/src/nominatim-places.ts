import type { AdapterContext, PlacesProvider, PlacesRequest } from "@rakazo/adapter-kit";
import type { PlacesCard } from "@rakazo/contracts";
import { PLACES_MAX_RESULTS, PlacesCardSchema } from "@rakazo/contracts";
import { distanceMeters } from "@rakazo/core";

export const DEFAULT_PLACES_LIMIT = 10;

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const TILE_ATTRIBUTION = "© OpenStreetMap contributors";
/** Half the height of the box a "near here" search looks in: about 15 km. */
const SEARCH_RADIUS_DEGREES = 0.135;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 100;

export type NominatimPlacesOptions = {
  fetch?: typeof globalThis.fetch;
  /** The search endpoint; point it at a self-hosted Nominatim. */
  searchUrl?: string;
  /** Tile template for web maps. Without one the web card shows the list alone. */
  tileUrl?: string;
  tileAttribution?: string;
  timeoutMs?: number;
  /** Gap between requests. The public service asks for at most one per second. */
  minIntervalMs?: number;
  userAgent?: string;
  /** Added to the User-Agent so the service's operators can reach whoever runs this. */
  contact?: string;
};

type NominatimItem = {
  place_id?: number;
  osm_type?: string;
  osm_id?: number;
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  category?: string;
  type?: string;
  address?: Record<string, string | undefined>;
  extratags?: Record<string, string | undefined> | null;
};

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function clampPlacesLimit(value: unknown): number {
  const limit =
    typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_PLACES_LIMIT;
  return Math.min(Math.max(limit, 1), PLACES_MAX_RESULTS);
}

function humanize(raw: string | undefined): string | undefined {
  const words = raw?.replaceAll("_", " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : undefined;
}

/** A short street address from the parts, or the long display name when there are none. */
function addressOf(item: NominatimItem, name: string): string | undefined {
  const a = item.address ?? {};
  const street = [a.road ?? a.pedestrian ?? a.footway, a.house_number].filter(Boolean).join(" ");
  const locality = a.city ?? a.town ?? a.village ?? a.municipality ?? a.suburb ?? a.county;
  const short = [street, locality].filter(Boolean).join(", ");
  if (short) return short.slice(0, 300);
  const rest = item.display_name?.split(", ").filter((part) => part !== name);
  return rest?.length ? rest.slice(0, 3).join(", ").slice(0, 300) : undefined;
}

/** Keyless place search from OpenStreetMap's Nominatim. Only the query and coordinates leave the server. */
export class NominatimPlacesProvider implements PlacesProvider {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly searchUrl: string;
  private readonly tileUrl: string | undefined;
  private readonly tileAttribution: string;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly userAgent: string;
  private readonly cache = new Map<string, { at: number; items: NominatimItem[] }>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: NominatimPlacesOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.searchUrl = options.searchUrl ?? NOMINATIM_URL;
    const tile = options.tileUrl?.trim();
    this.tileUrl = tile && tile.toLowerCase() !== "off" ? tile : undefined;
    this.tileAttribution = options.tileAttribution ?? TILE_ATTRIBUTION;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.minIntervalMs = options.minIntervalMs ?? 1_100;
    const base =
      options.userAgent ?? "Rakazo/0.1 (+https://github.com/elie222/rakazo; places tool)";
    this.userAgent = options.contact ? `${base} ${options.contact}` : base;
  }

  describe() {
    return {
      id: "nominatim",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { keyless: true },
    };
  }

  /** One request at a time with a gap between them, as the public service's usage policy asks. */
  private async spaced<T>(task: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      // A cancelled run leaves the queue without sending anything or delaying the next one.
      if (wait > 0) await sleep(wait, signal);
      signal?.throwIfAborted();
      try {
        return await task();
      } finally {
        this.lastRequestAt = Date.now();
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fetchItems(
    params: Record<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<NominatimItem[]> {
    const url = new URL(this.searchUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("format", "jsonv2");
    const key = url.toString();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items;
    const items = await this.spaced(async () => {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          headers: { accept: "application/json", "user-agent": this.userAgent },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch {
        throw new Error("The places service could not be reached. Try again later.");
      }
      if (!response.ok) {
        throw new Error(`The places service answered ${response.status}. Try again later.`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error("The places service sent a reply that could not be read.");
      }
      if (!Array.isArray(body)) {
        throw new Error("The places service sent a reply that could not be read.");
      }
      return body as NominatimItem[];
    }, signal);
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: Date.now(), items });
    return items;
  }

  private async resolveCentre(request: PlacesRequest) {
    const { latitude, longitude } = request;
    const near = request.near?.trim();
    const hasCoordinates = latitude !== undefined || longitude !== undefined;
    if (near && hasCoordinates) {
      throw new Error("Give either a place name or latitude and longitude, not both.");
    }
    if (hasCoordinates) {
      if (
        latitude === undefined ||
        longitude === undefined ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180
      ) {
        throw new Error("Latitude must be -90 to 90 and longitude -180 to 180, given together.");
      }
      return { latitude, longitude };
    }
    if (!near) return undefined;
    const [hit] = await this.fetchItems({ q: near, limit: "1" }, request.signal);
    const lat = Number(hit?.lat);
    const lon = Number(hit?.lon);
    if (!hit || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`Could not find a place called "${near}". Try a larger town or a city name.`);
    }
    return { latitude: lat, longitude: lon };
  }

  async search(request: PlacesRequest, _context: AdapterContext): Promise<PlacesCard> {
    const query = request.query?.trim().slice(0, 200);
    if (!query) throw new Error("Say what to look for, such as a kind of place or an address.");
    const limit = clampPlacesLimit(request.limit);
    const centre = await this.resolveCentre(request);
    const params: Record<string, string> = {
      q: query,
      limit: String(limit),
      addressdetails: "1",
      extratags: "1",
      dedupe: "1",
    };
    if (centre) {
      const dLat = SEARCH_RADIUS_DEGREES;
      const dLon = Math.min(
        180,
        dLat / Math.max(Math.cos((centre.latitude * Math.PI) / 180), 0.05),
      );
      // Nominatim wants left, top, right, bottom. Near the date line the box is left to the service.
      const left = centre.longitude - dLon;
      const right = centre.longitude + dLon;
      if (left >= -180 && right <= 180) {
        params.viewbox = [left, centre.latitude + dLat, right, centre.latitude - dLat]
          .map((n) => n.toFixed(5))
          .join(",");
        params.bounded = "1";
      } else {
        params.viewbox = [
          Math.max(left, -180),
          centre.latitude + dLat,
          Math.min(right, 180),
          centre.latitude - dLat,
        ]
          .map((n) => n.toFixed(5))
          .join(",");
      }
    }
    const items = await this.fetchItems(params, request.signal);
    const seen = new Set<string>();
    const places: PlacesCard["places"] = [];
    for (const item of items) {
      const latitude = Number(item.lat);
      const longitude = Number(item.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
      const id =
        item.osm_type && item.osm_id !== undefined
          ? `${item.osm_type}${item.osm_id}`
          : String(item.place_id ?? "");
      const name = (item.name || item.display_name?.split(", ")[0] || "").trim().slice(0, 200);
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      const hours = item.extratags?.opening_hours?.trim();
      places.push({
        id: id.slice(0, 100),
        name,
        category: humanize(item.type && item.type !== "yes" ? item.type : item.category)?.slice(
          0,
          100,
        ),
        address: addressOf(item, name),
        latitude,
        longitude,
        ...(centre ? { distanceM: distanceMeters(centre, { latitude, longitude }) } : {}),
        ...(hours ? { hours: hours.slice(0, 300) } : {}),
      });
    }
    if (places.length === 0) {
      throw new Error(
        centre
          ? `No places matched "${query}" near there.`
          : `No places matched "${query}". Try a different name or add a town.`,
      );
    }
    if (centre) places.sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0));
    return PlacesCardSchema.parse({
      query,
      ...(centre ? { centre } : {}),
      places: places.slice(0, limit),
      ...(this.tileUrl
        ? { map: { tileUrl: this.tileUrl, attribution: this.tileAttribution } }
        : {}),
      attribution: {
        name: "© OpenStreetMap contributors",
        url: "https://www.openstreetmap.org/copyright",
      },
    });
  }
}
