import { describe, expect, it } from "vitest";
import { confirmUpdaterRecreate, isLikelyUpdaterRecreateDisconnect } from "./updater-recreate.js";

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

describe("confirmUpdaterRecreate", () => {
  it("requires an idle sidecar and a changed image tag", () => {
    expect(
      confirmUpdaterRecreate({
        beforeImageTag: "sha-aaa",
        afterImageTag: "sha-bbb",
        running: false,
        supported: true,
        installKind: "sidecar",
      }),
    ).toEqual({ confirmed: true, reason: "changed" });
    expect(
      confirmUpdaterRecreate({
        beforeImageTag: "sha-aaa",
        afterImageTag: "sha-bbb",
        running: true,
        supported: true,
        installKind: "sidecar",
      }),
    ).toEqual({ confirmed: false, reason: "running" });
    expect(
      confirmUpdaterRecreate({
        beforeImageTag: "sha-aaa",
        afterImageTag: "sha-aaa",
        running: false,
        supported: true,
        installKind: "sidecar",
      }),
    ).toEqual({ confirmed: false, reason: "unchanged" });
  });

  it("does not treat a compose fallback with a changed configured tag as success", () => {
    expect(
      confirmUpdaterRecreate({
        beforeImageTag: "sha-aaa",
        afterImageTag: "sha-bbb",
        running: false,
        supported: false,
        installKind: "compose",
      }),
    ).toEqual({ confirmed: false, reason: "waiting" });
  });
});
