import { requireOptionalNativeModule } from "expo-modules-core";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
});

it("clears the native cache when the module is present", async () => {
  const clear = vi.fn();
  vi.mocked(requireOptionalNativeModule).mockReturnValue({ clear });
  const { clearNetworkCache } = await import("./network-cache.js");

  clearNetworkCache();

  expect(requireOptionalNativeModule).toHaveBeenCalledWith("RakazoNetworkCache");
  expect(clear).toHaveBeenCalledOnce();
});

it("does nothing where the module is missing", async () => {
  vi.mocked(requireOptionalNativeModule).mockReturnValue(null);
  const { clearNetworkCache } = await import("./network-cache.js");

  expect(() => clearNetworkCache()).not.toThrow();
});
