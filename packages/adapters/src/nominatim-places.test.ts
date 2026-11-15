import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clampPlacesLimit, NominatimPlacesProvider } from "./nominatim-places.js";

const context = {} as AdapterContext;

const item = (id: number, name: string, lat: number, lon: number, extra = {}) => ({
  place_id: id,
  osm_type: "node",
  osm_id: id,
  lat: String(lat),
  lon: String(lon),
  name,
  display_name: `${name}, Example Street, Lisbon, Portugal`,
  category: "amenity",
  type: "pharmacy",
  address: { road: "Rua Example", house_number: "12", city: "Lisbon" },
  extratags: { opening_hours: "Mo-Fr 09:00-19:00" },
  ...extra,
});

describe("NominatimPlacesProvider", () => {
  let server: Server;
  let base: string;
  const seen: { query: string; agent: string | undefined }[] = [];
  let mode: "ok" | "down" | "garbage" | "empty" | "many" | "weird" = "ok";

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://mock");
      seen.push({ query: url.searchParams.toString(), agent: req.headers["user-agent"] });
      if (mode === "down") {
        res.statusCode = 503;
        res.end("busy");
        return;
      }
      if (mode === "garbage") {
        res.end("<html>nope</html>");
        return;
      }
      res.setHeader("content-type", "application/json");
      const q = url.searchParams.get("q") ?? "";
      if (mode === "empty" || q === "Nowhereville") {
        res.end("[]");
        return;
      }
      if (url.searchParams.get("limit") === "1") {
        res.end(JSON.stringify([item(1, "Lisbon", 38.7223, -9.1393)]));
        return;
      }
      if (mode === "many") {
        res.end(
          JSON.stringify(
            Array.from({ length: 30 }, (_, i) => item(100 + i, `P${i}`, 38.7 + i / 1000, -9.1)),
          ),
        );
        return;
      }
      if (mode === "weird") {
        res.end(
          JSON.stringify([
            item(5, "", 38.7, -9.1, { display_name: "Fallback Name, Lisbon" }),
            item(6, "Bad coords", 999, 0),
            item(7, "Nan", Number.NaN, 0),
            item(5, "Duplicate", 38.7, -9.1),
            item(8, "Ok place", -33.87, 151.21, {
              type: "yes",
              address: undefined,
              extratags: null,
            }),
          ]),
        );
        return;
      }
      res.end(
        JSON.stringify([
          item(10, "Far Pharmacy", 38.78, -9.14),
          item(11, "Near Pharmacy", 38.7225, -9.1395),
        ]),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/search`;
  });
  afterAll(() => server.close());
  beforeEach(() => {
    seen.length = 0;
    mode = "ok";
  });

  const provider = (options = {}) =>
    new NominatimPlacesProvider({ searchUrl: base, minIntervalMs: 0, ...options });

  it("geocodes the place, searches inside a box around it and sorts by distance", async () => {
    const card = await provider({ contact: "ops@example.test" }).search(
      { query: "pharmacy", near: "Lisbon" },
      context,
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]?.query).toContain("q=Lisbon");
    expect(seen[1]?.query).toContain("bounded=1");
    expect(seen[1]?.query).toContain("viewbox=");
    expect(seen[1]?.agent).toMatch(/Rakazo.*ops@example\.test/);
    expect(card.places.map((place) => place.name)).toEqual(["Near Pharmacy", "Far Pharmacy"]);
    expect(card.places[0]).toMatchObject({
      id: "node11",
      category: "Pharmacy",
      address: "Rua Example 12, Lisbon",
      hours: "Mo-Fr 09:00-19:00",
    });
    expect(card.places[0]?.distanceM).toBeLessThan(card.places[1]?.distanceM ?? 0);
    expect(card.centre).toEqual({ latitude: 38.7223, longitude: -9.1393 });
    expect(card.attribution.url).toBe("https://www.openstreetmap.org/copyright");
    expect(card.map).toBeUndefined();
  });

  it("searches around coordinates with one request, and sends nothing else", async () => {
    await provider().search({ query: "cafe", latitude: -33.87, longitude: 151.21 }, context);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.query).not.toContain("near");
  });

  it("looks up a bare address with no box and no distances", async () => {
    const card = await provider().search({ query: "1 Example Street, Lisbon" }, context);
    expect(seen[0]?.query).not.toContain("viewbox");
    expect(card.centre).toBeUndefined();
    expect(card.places[0]?.distanceM).toBeUndefined();
  });

  it("caps a huge result list at the limit", async () => {
    mode = "many";
    const card = await provider().search(
      { query: "x", latitude: 38.7, longitude: -9.1, limit: 500 },
      context,
    );
    expect(card.places).toHaveLength(20);
    expect(clampPlacesLimit(0)).toBe(1);
    expect(clampPlacesLimit(Number.NaN)).toBe(10);
  });

  it("skips unusable rows and tolerates missing fields", async () => {
    mode = "weird";
    const card = await provider().search({ query: "x" }, context);
    expect(card.places.map((place) => place.name)).toEqual(["Fallback Name", "Ok place"]);
    expect(card.places[1]).toMatchObject({ latitude: -33.87, longitude: 151.21 });
  });

  it("draws no map unless a tile template is set, and honours a custom one", async () => {
    expect((await provider().search({ query: "x" }, context)).map).toBeUndefined();
    expect(
      (await provider({ tileUrl: "off" }).search({ query: "x" }, context)).map,
    ).toBeUndefined();
    const custom = await provider({ tileUrl: "https://tiles.example.test/{z}/{x}/{y}.png" }).search(
      { query: "x" },
      context,
    );
    expect(custom.map?.tileUrl).toBe("https://tiles.example.test/{z}/{x}/{y}.png");
  });

  it("explains unknown places, empty results, bad input, outages and garbage", async () => {
    await expect(
      provider().search({ query: "pharmacy", near: "Nowhereville" }, context),
    ).rejects.toThrow(/Could not find a place called "Nowhereville"/);
    mode = "empty";
    await expect(
      provider().search({ query: "x", latitude: 1, longitude: 1 }, context),
    ).rejects.toThrow(/No places matched/);
    await expect(provider().search({ query: "  " }, context)).rejects.toThrow(
      /Say what to look for/,
    );
    await expect(
      provider().search({ query: "x", near: "Lisbon", latitude: 1, longitude: 1 }, context),
    ).rejects.toThrow(/not both/);
    await expect(
      provider().search({ query: "x", latitude: 91, longitude: 1 }, context),
    ).rejects.toThrow(/Latitude must be/);
    await expect(provider().search({ query: "x", latitude: 1 }, context)).rejects.toThrow(
      /together/,
    );
    mode = "down";
    await expect(provider().search({ query: "x" }, context)).rejects.toThrow(/answered 503/);
    mode = "garbage";
    await expect(provider().search({ query: "y" }, context)).rejects.toThrow(/could not be read/);
    await expect(
      new NominatimPlacesProvider({
        searchUrl: "http://127.0.0.1:1/search",
        minIntervalMs: 0,
      }).search({ query: "z" }, context),
    ).rejects.toThrow(/could not be reached/);
  });

  it("passes injection-like text as data and keeps long names within the contract", async () => {
    mode = "ok";
    const card = await provider().search(
      {
        query: "pharmacy'; DROP TABLE places;-- <script>alert(1)</script>",
        latitude: 1,
        longitude: 1,
      },
      context,
    );
    expect(seen[0]?.query).toContain("DROP+TABLE");
    expect(card.query).toContain("<script>");
    mode = "weird";
    const long = await provider().search({ query: "x".repeat(900) }, context);
    expect(long.query).toHaveLength(200);
  });

  it("leaves the queue when a run is cancelled while waiting its turn", async () => {
    const slow = provider({ minIntervalMs: 400 });
    await slow.search({ query: "first", latitude: 1, longitude: 1 }, context);
    const controller = new AbortController();
    const waiting = slow.search(
      { query: "second", latitude: 2, longitude: 2, signal: controller.signal },
      context,
    );
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow(/cancelled/);
    const count = seen.length;
    const started = Date.now();
    await slow.search({ query: "third", latitude: 3, longitude: 3 }, context);
    expect(seen).toHaveLength(count + 1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("spaces requests and reuses a recent identical answer", async () => {
    const slow = provider({ minIntervalMs: 60 });
    const started = Date.now();
    await slow.search({ query: "pharmacy", near: "Lisbon" }, context);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    const count = seen.length;
    await slow.search({ query: "pharmacy", near: "Lisbon" }, context);
    expect(seen).toHaveLength(count);
  });
});
