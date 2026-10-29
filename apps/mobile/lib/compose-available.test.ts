import { afterEach, describe, expect, it, vi } from "vitest";

async function lookup(expo: unknown) {
  vi.resetModules();
  vi.stubGlobal("expo", expo);
  return (await import("./compose-available")).isComposeViewAvailable;
}

afterEach(() => vi.unstubAllGlobals());

describe("Compose view availability", () => {
  it("checks named ExpoUI configs and caches each view independently", async () => {
    const getViewConfig = vi.fn((_module, view) => (view === "SwitchView" ? {} : null));
    const available = await lookup({ getViewConfig });
    expect(available("SwitchView")).toBe(true);
    expect(available("SwitchView")).toBe(true);
    expect(available("SegmentedButtonView")).toBe(false);
    expect(available("SegmentedButtonView")).toBe(false);
    expect(getViewConfig.mock.calls).toEqual([
      ["ExpoUI", "SwitchView"],
      ["ExpoUI", "SegmentedButtonView"],
    ]);
  });

  it.each([
    undefined,
    {},
    {
      getViewConfig: () => {
        throw new Error("Unavailable");
      },
    },
  ])("safely rejects unavailable lookups (%j)", async (expo) => {
    const available = await lookup(expo);
    expect(() => available("HostView")).not.toThrow();
    expect(available("HostView")).toBe(false);
  });
});
