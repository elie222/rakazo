import { afterEach, expect, it, vi } from "vitest";
import { fetchStoreVersion, isNewerVersion } from "./store-update";

vi.mock("expo-application", () => ({}));
vi.mock("react-native", () => ({ Linking: { openURL: vi.fn() }, Platform: { OS: "ios" } }));
vi.mock("./query", () => ({ queryClient: {} }));

afterEach(() => vi.unstubAllGlobals());

it("compares dotted versions numerically", () => {
  expect(isNewerVersion("1.0.12", "1.0.11")).toBe(true);
  expect(isNewerVersion("1.0.10", "1.0.9")).toBe(true);
  expect(isNewerVersion("1.1", "1.0.12")).toBe(true);
  expect(isNewerVersion("1.0.12", "1.0.12")).toBe(false);
  expect(isNewerVersion("1.0", "1.0.0")).toBe(false);
  expect(isNewerVersion("1.0.11", "1.0.12")).toBe(false);
  expect(isNewerVersion("", "1.0.0")).toBe(false);
  expect(isNewerVersion("1.0.12-beta", "1.0.0")).toBe(false);
});

it("reads the store version for the bundle", async () => {
  const fetch = vi.fn(async (_url: string) => Response.json({ results: [{ version: "1.0.12" }] }));
  vi.stubGlobal("fetch", fetch);
  await expect(fetchStoreVersion("com.example.app")).resolves.toBe("1.0.12");
  expect(String(fetch.mock.calls[0]?.[0])).toContain("bundleId=com.example.app");
});

it("returns null when the store does not list the app", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ results: [] })),
  );
  await expect(fetchStoreVersion("com.example.app")).resolves.toBeNull();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 503 })),
  );
  await expect(fetchStoreVersion("com.example.app")).resolves.toBeNull();
});
