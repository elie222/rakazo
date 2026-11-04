import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearLastBot, loadLastBotId, saveLastBotId } from "./last-bot";
import { registerSessionDiskCache, saveSessionToken } from "./session";

const { saved } = vi.hoisted(() => ({ saved: new Map<string, string>() }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => saved.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    saved.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    saved.delete(key);
  },
}));
// The session module pulls these in; only their clearing matters here.
vi.mock("./live-notifications", () => ({ stopLiveNotifications: vi.fn(async () => undefined) }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./thread-feedback", () => ({ clearFailedSends: vi.fn() }));

registerSessionDiskCache(() => void clearLastBot());

describe("last bot shortcut target", () => {
  beforeEach(() => saved.clear());

  it("does not carry an explicit Space into a later default-Space chat", async () => {
    await saveLastBotId("researcher", "shared-space");
    expect(await loadLastBotId()).toBe("researcher");
    expect(saved.get("rakazo.last_bot_space_id")).toBe("shared-space");

    await saveLastBotId("writer", null);
    expect(await loadLastBotId()).toBe("writer");
    expect(saved.has("rakazo.last_bot_space_id")).toBe(false);
  });

  it("clears the last bot when another account signs in", async () => {
    await saveLastBotId("researcher", "shared-space");
    expect(await loadLastBotId()).toBe("researcher");

    await saveSessionToken("other-account-session");
    expect(await loadLastBotId()).toBe("");
    expect(saved.has("rakazo.last_bot_space_id")).toBe(false);
  });

  it("is registered as an app-level session disk cache", () => {
    const layout = readFileSync(resolve(import.meta.dirname, "../app/_layout.tsx"), "utf8");
    expect(layout).toContain("registerSessionDiskCache(() => void clearLastBot())");
  });
});
