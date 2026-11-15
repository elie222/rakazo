import { describe, expect, it } from "vitest";
import {
  clusterPlaces,
  distanceMeters,
  fitViewport,
  formatDistance,
  frameTiles,
  placeMapsUrl,
  projectToFrame,
  tileCoordinates,
  usesMiles,
  viewportAt,
  viewportCentre,
} from "./places.js";

describe("places view model", () => {
  it("measures distances, including across the date line and in the south", () => {
    expect(distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 })).toBe(0);
    expect(
      distanceMeters({ latitude: 38.72, longitude: -9.14 }, { latitude: 38.73, longitude: -9.14 }),
    ).toBeCloseTo(1112, -1);
    const dateLine = distanceMeters(
      { latitude: -17, longitude: 179.9 },
      { latitude: -17, longitude: -179.9 },
    );
    expect(dateLine).toBeLessThan(25_000);
  });

  it("formats metric and imperial distances", () => {
    expect(formatDistance(450, false, "en")).toBe("450 m");
    expect(formatDistance(1234, false, "en")).toBe("1.2 km");
    expect(formatDistance(25_000, false, "en")).toBe("25 km");
    expect(formatDistance(800, true, "en")).toBe("0.5 mi");
    expect(usesMiles("en-US")).toBe(true);
    expect(usesMiles("pt-PT")).toBe(false);
    expect(usesMiles(undefined)).toBe(false);
  });

  it("fits places in a frame and keeps pins inside it", () => {
    const places = [
      { latitude: 38.7, longitude: -9.15 },
      { latitude: 38.74, longitude: -9.12 },
    ];
    const view = fitViewport(places, 600, 280);
    for (const place of places) {
      const { left, top } = projectToFrame(place, view, 600, 280);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(600);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThanOrEqual(280);
    }
    expect(fitViewport([places[0]!], 600, 280).zoom).toBe(17);
  });

  it("fits places that straddle the date line the short way round", () => {
    const places = [
      { latitude: -17.7, longitude: 179.95 },
      { latitude: -17.8, longitude: -179.95 },
    ];
    const view = fitViewport(places, 400, 240);
    expect(view.zoom).toBeGreaterThan(8);
    const a = projectToFrame(places[0]!, view, 400, 240);
    const b = projectToFrame(places[1]!, view, 400, 240);
    expect(Math.abs(a.left - b.left)).toBeLessThan(400);
  });

  it("covers the frame with tiles, wrapping across the antimeridian and clamping rows", () => {
    const view = fitViewport([{ latitude: -17.7, longitude: 179.99 }], 400, 240);
    const tiles = frameTiles("https://t.test/{z}/{x}/{y}.png", view, 400, 240);
    const n = 2 ** view.zoom;
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      const [, x, y] = tile.url
        .replace("https://t.test/", "")
        .replace(".png", "")
        .split("/")
        .map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(n);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(n);
    }
    expect(tileCoordinates({ latitude: 90, longitude: 0 }, 3).y).toBeGreaterThanOrEqual(0);
  });

  it("builds maps links for each platform, escaping the name", () => {
    const place = { name: "Café & Co", latitude: -33.8688, longitude: 151.2093 };
    expect(placeMapsUrl(place, "apple")).toBe(
      "https://maps.apple.com/?ll=-33.868800,151.209300&q=Caf%C3%A9%20%26%20Co",
    );
    expect(placeMapsUrl(place, "web")).toBe(
      "https://www.openstreetmap.org/?mlat=-33.868800&mlon=151.209300#map=17/-33.868800/151.209300",
    );
  });

  it("groups pins closer than a pin is wide and keeps the rest single", () => {
    const at = (id: string, latitude: number, longitude: number) => ({ id, latitude, longitude });
    const places = [
      at("a", 52.52, 13.405),
      at("b", 52.5201, 13.4051),
      at("c", 52.5202, 13.4052),
      at("d", 52.56, 13.5),
    ];
    const zoomedOut = clusterPlaces(places, 13);
    expect(zoomedOut.map((c) => [c.id, c.members.length])).toEqual([
      ["group:a", 3],
      ["d", 1],
    ]);
    expect(zoomedOut[0]?.latitude).toBeCloseTo(52.5201, 3);
    // Zooming in pulls the group apart.
    expect(clusterPlaces(places, 19).map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
    // Every place is in exactly one cluster, in list order.
    expect(zoomedOut.flatMap((c) => c.members.map((m) => m.id))).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps places at the same spot together at any zoom and groups across the date line", () => {
    const same = [
      { id: "x", latitude: 10, longitude: 10 },
      { id: "y", latitude: 10, longitude: 10 },
    ];
    expect(clusterPlaces(same, 17)).toHaveLength(1);
    const across = clusterPlaces(
      [
        { id: "w", latitude: 0, longitude: 179.9999 },
        { id: "e", latitude: 0, longitude: -179.9999 },
      ],
      12,
    );
    expect(across).toHaveLength(1);
    expect(Math.abs(across[0]?.longitude ?? 0)).toBeGreaterThan(179.99);
    expect(clusterPlaces([], 10)).toEqual([]);
  });

  it("round-trips a viewport centre", () => {
    const point = { latitude: -33.87, longitude: 151.21 };
    const back = viewportCentre(viewportAt(point, 14));
    expect(back.latitude).toBeCloseTo(point.latitude, 5);
    expect(back.longitude).toBeCloseTo(point.longitude, 5);
  });

  it("never leaves two groups closer than a pin, however the places are ordered", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const zoom = 13;
    for (let run = 0; run < 200; run += 1) {
      const places = Array.from({ length: 20 }, (_, i) => ({
        id: String(i),
        latitude: 38.7 + random() * 0.05,
        longitude: -9.15 + random() * 0.08,
      }));
      const clusters = clusterPlaces(places, zoom, 30);
      const px = clusters.map((c) => tileCoordinates(c, zoom));
      for (let i = 0; i < px.length; i += 1) {
        for (let j = i + 1; j < px.length; j += 1) {
          const a = px[i] as { x: number; y: number };
          const b = px[j] as { x: number; y: number };
          expect(Math.hypot((a.x - b.x) * 256, (a.y - b.y) * 256)).toBeGreaterThanOrEqual(29.9);
        }
      }
      expect(clusters.flatMap((c) => c.members.map((m) => m.id)).sort()).toEqual(
        places.map((p) => p.id).sort(),
      );
    }
  });
});
