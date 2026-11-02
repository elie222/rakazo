import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadLastBotId, saveLastBotId } from "./last-bot";

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
});
