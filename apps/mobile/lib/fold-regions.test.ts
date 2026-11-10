// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));

it("returns no fold on an older binary without the optional module", async () => {
  const { useFoldRegions } = await import("./fold-regions");
  let regions: unknown;
  function Probe() {
    regions = useFoldRegions();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));
  expect(regions).toEqual([]);
  await act(async () => root.unmount());
});
