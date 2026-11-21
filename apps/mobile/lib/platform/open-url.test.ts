import { beforeEach, expect, it, vi } from "vitest";
import { openExternalUrl } from "./open-url";

const mocks = vi.hoisted(() => ({ openURL: vi.fn(), openBrowserAsync: vi.fn() }));
vi.mock("react-native", () => ({ Linking: { openURL: mocks.openURL } }));
vi.mock("expo-web-browser", () => ({ openBrowserAsync: mocks.openBrowserAsync }));

beforeEach(() => {
  mocks.openURL.mockReset().mockResolvedValue(true);
  mocks.openBrowserAsync.mockReset().mockResolvedValue({ type: "opened" });
});

it("opens a link through the system", async () => {
  await openExternalUrl("https://example.test/terms/");
  expect(mocks.openURL).toHaveBeenCalledWith("https://example.test/terms/");
  expect(mocks.openBrowserAsync).not.toHaveBeenCalled();
});

it("opens a web page the system refuses in the in-app browser", async () => {
  mocks.openURL.mockRejectedValue(new Error("Unable to open URL: https://example.test/terms/"));
  await openExternalUrl("https://example.test/terms/");
  expect(mocks.openBrowserAsync).toHaveBeenCalledWith("https://example.test/terms/");
});

it("falls back when the system opener throws instead of rejecting", async () => {
  mocks.openURL.mockImplementation(() => {
    throw new Error("Could not open URL");
  });
  await openExternalUrl("https://example.test/terms/");
  expect(mocks.openBrowserAsync).toHaveBeenCalledWith("https://example.test/terms/");
});

it("settles without a browser fallback when nothing can open the link", async () => {
  mocks.openURL.mockRejectedValue(new Error("No Activity found to handle Intent"));
  await expect(openExternalUrl("example")).resolves.toBeUndefined();
  expect(mocks.openBrowserAsync).not.toHaveBeenCalled();
  mocks.openBrowserAsync.mockRejectedValue(new Error("no browser"));
  await expect(openExternalUrl("https://example.test/")).resolves.toBeUndefined();
});
