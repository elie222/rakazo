import { describe, expect, it } from "vitest";
import { isLikelyUpdaterRecreateDisconnect } from "./updater-recreate.js";

describe("isLikelyUpdaterRecreateDisconnect", () => {
  it("recognizes common browser and Node transport failures after API recreate", () => {
    expect(isLikelyUpdaterRecreateDisconnect(new Error("Failed to fetch"))).toBe(true);
    expect(
      isLikelyUpdaterRecreateDisconnect(new Error("NetworkError when attempting to fetch")),
    ).toBe(true);
    expect(isLikelyUpdaterRecreateDisconnect(new Error("socket hang up"))).toBe(true);
    expect(isLikelyUpdaterRecreateDisconnect(new Error("ECONNREFUSED"))).toBe(true);
  });

  it("does not treat ordinary updater errors as recreate disconnects", () => {
    expect(
      isLikelyUpdaterRecreateDisconnect(new Error("The updater sidecar is not configured.")),
    ).toBe(false);
    expect(isLikelyUpdaterRecreateDisconnect("failed to fetch")).toBe(false);
    expect(isLikelyUpdaterRecreateDisconnect(null)).toBe(false);
  });
});
