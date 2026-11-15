import type { AdapterContext, PlacesProvider, PlacesRequest } from "@rakazo/adapter-kit";
import type { PlacesCard } from "@rakazo/contracts";
import { distanceMeters } from "@rakazo/core";
import { clampPlacesLimit } from "./nominatim-places.js";

const CENTRE = { latitude: 38.7223, longitude: -9.1393 };
const NAMES = ["Farmácia Central", "Farmácia do Largo", "Pharmacy Rossio", "Farmácia Chiado"];

/** A deterministic result for offline tests: never touches the network. */
export function fakePlacesCard(query: string, limit = 4): PlacesCard {
  const places = NAMES.slice(0, Math.min(limit, NAMES.length)).map((name, i) => {
    const latitude = CENTRE.latitude + (i - 1.5) * 0.004;
    const longitude = CENTRE.longitude + (i % 2 === 0 ? 0.003 : -0.003) * (i + 1);
    return {
      id: `node${1000 + i}`,
      name,
      category: "Pharmacy",
      address: `Rua Example ${10 + i}, Lisbon`,
      latitude,
      longitude,
      distanceM: distanceMeters(CENTRE, { latitude, longitude }),
      ...(i === 0 ? { hours: "Mo-Fr 09:00-19:00; Sa 09:00-13:00" } : {}),
    };
  });
  places.sort((a, b) => a.distanceM - b.distanceM);
  return {
    query,
    centre: CENTRE,
    places,
    attribution: {
      name: "© OpenStreetMap contributors",
      url: "https://www.openstreetmap.org/copyright",
    },
  };
}

export class FakePlacesProvider implements PlacesProvider {
  error: Error | undefined;
  lastRequest: PlacesRequest | undefined;

  describe() {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { keyless: true },
    };
  }

  async search(request: PlacesRequest, _context: AdapterContext): Promise<PlacesCard> {
    this.lastRequest = request;
    if (this.error) throw this.error;
    return fakePlacesCard(request.query, clampPlacesLimit(request.limit));
  }
}
