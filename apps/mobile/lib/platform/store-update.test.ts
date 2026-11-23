import { afterEach, expect, it, vi } from "vitest";
import { fetchStoreListing, isNewerVersion, openStoreListing } from "./store-update";

const state = vi.hoisted(() => ({
  bundleId: "com.example.app",
  getQueryData: vi.fn(),
  openURL: vi.fn(async () => undefined),
}));
vi.mock("expo-application", () => ({
  get applicationId() {
    return state.bundleId;
  },
}));
vi.mock("react-native", () => ({ Linking: { openURL: state.openURL }, Platform: { OS: "ios" } }));
vi.mock("@rakazo/contracts", () => ({
  IOS_APP_STORE_URL: "https://apps.apple.com/app/rakazo/id6801531099",
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));
vi.mock("../query/query", () => ({ queryClient: { getQueryData: state.getQueryData } }));

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
  await expect(fetchStoreListing("com.example.app")).resolves.toEqual({
    version: "1.0.12",
    url: null,
  });
  expect(String(fetch.mock.calls[0]?.[0])).toContain("bundleId=com.example.app");
});

it("returns null when the store does not list the app", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ results: [] })),
  );
  await expect(fetchStoreListing("com.example.app")).resolves.toBeNull();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 503 })),
  );
  await expect(fetchStoreListing("com.example.app")).resolves.toBeNull();
});

it("opens the cached listing for the current branded bundle without refetching", () => {
  state.bundleId = "com.example.app";
  state.openURL.mockClear();
  state.getQueryData.mockReturnValueOnce({
    version: "1.0.12",
    url: "https://apps.apple.com/us/app/example/id12345",
  });
  openStoreListing();
  expect(state.getQueryData).toHaveBeenCalledWith(["store-version", "com.example.app"]);
  expect(state.openURL).toHaveBeenCalledExactlyOnceWith(
    "https://apps.apple.com/us/app/example/id12345",
  );
});

it("does not fall back to Rakazo for an unlisted custom bundle", () => {
  state.bundleId = "com.example.app";
  state.openURL.mockClear();
  openStoreListing();
  expect(state.openURL).not.toHaveBeenCalled();
});

it("keeps the official listing as a fallback for the original bundle", () => {
  state.bundleId = "com.rakazo.app";
  state.openURL.mockClear();
  openStoreListing();
  expect(state.openURL).toHaveBeenCalledExactlyOnceWith(
    "https://apps.apple.com/app/rakazo/id6801531099",
  );
});

it.each([
  [
    "https://apps.apple.com/us/app/example/id12345",
    "https://apps.apple.com/us/app/example/id12345",
  ],
  ["http://apps.apple.com/us/app/example/id12345", null],
  ["https://apps.apple.com.example.com/app/id12345", null],
  ["https://apps.apple.com/story/id12345", null],
  ["not a URL", null],
])("validates the listing URL %s", async (trackViewUrl, url) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ results: [{ version: "2.0", trackViewUrl }] })),
  );
  await expect(fetchStoreListing("com.example.app")).resolves.toEqual({ version: "2.0", url });
});
