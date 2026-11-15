import { fitViewport, usesMiles } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { cameraFromViewport, prefersMiles } from "./places-view";

const placesCamera = (places: { latitude: number; longitude: number }[], w: number, h: number) =>
  cameraFromViewport(fitViewport(places, w, h, 56));

describe("cameraFromViewport", () => {
  it("centres between places and zooms out to fit them", () => {
    const camera = placesCamera(
      [
        { latitude: 48.85, longitude: 2.3 },
        { latitude: 48.87, longitude: 2.4 },
      ],
      320,
      220,
    );
    expect(camera.coordinates.latitude).toBeCloseTo(48.86, 2);
    expect(camera.coordinates.longitude).toBeCloseTo(2.35, 2);
    expect(camera.zoom).toBeGreaterThan(9);
    expect(camera.zoom).toBeLessThanOrEqual(18);
  });

  it("keeps a single place at street level and the date line together", () => {
    expect(placesCamera([{ latitude: 10, longitude: -170 }], 320, 220).zoom).toBe(18);
    const across = placesCamera(
      [
        { latitude: 0, longitude: 179 },
        { latitude: 0, longitude: -179 },
      ],
      320,
      220,
    );
    expect(Math.abs(across.coordinates.longitude)).toBeGreaterThan(178);
  });
});

describe("prefersMiles", () => {
  it("follows the measurement system, then the region", () => {
    expect(prefersMiles({ measurementSystem: "us" }, usesMiles)).toBe(true);
    expect(prefersMiles({ measurementSystem: "metric", languageTag: "en-US" }, usesMiles)).toBe(
      false,
    );
    expect(prefersMiles({ languageTag: "en-GB" }, usesMiles)).toBe(true);
    expect(prefersMiles(undefined, usesMiles)).toBe(false);
  });
});
