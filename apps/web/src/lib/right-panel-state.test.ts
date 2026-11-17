import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readLastBotTab,
  readRightPanelState,
  rightPanelStorageKey,
  writeRightPanelState,
} from "./right-panel-state";

afterEach(() => vi.unstubAllGlobals());
describe("right panel preferences", () => {
  it("round trips closed state and only the selected routine reference", () => {
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    });
    writeRightPanelState("user-a:space-a:bot-a", "routine", "routine-a");
    expect(readRightPanelState("user-a:space-a:bot-a")).toEqual({
      panel: "routine",
      routineId: "routine-a",
    });
    expect(readRightPanelState("user-b:space-a:bot-a")).toEqual({ panel: null });
    writeRightPanelState("user-a:space-a:bot-a", null, "routine-a");
    expect(readRightPanelState("user-a:space-a:bot-a")).toEqual({ panel: null });
  });
  it.each(["computer", "routines", "pages", "settings"])(
    "reopens a stored %s tab on the bot's panel",
    (panel) => {
      // A bot's panel comes back where it was left, so a watch on the computer survives a reload.
      vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ panel }) });
      expect(readRightPanelState("state")).toEqual({ panel });
    },
  );
  it.each([
    "not json",
    "null",
    "[]",
    '{"panel":"unknown"}',
    '{"panel":{}}',
    '{"panel":"create-group"}',
    '{"panel":"import-agent"}',
  ])("ignores malformed preference %s", (value) => {
    vi.stubGlobal("localStorage", { getItem: () => value });
    expect(readRightPanelState("state")).toEqual({ panel: null });
  });
  it("keeps working when browser storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(readRightPanelState("state")).toEqual({ panel: null });
    expect(() => writeRightPanelState("state", "settings")).not.toThrow();
  });
  it("skips the ephemeral create-group panel and builds scoped keys", () => {
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    });
    const key = rightPanelStorageKey("user-a", "space-a", "bot", "bot-a");
    expect(key).toBe("rakazo:right-panel-state:user-a:space-a:bot:bot-a");
    writeRightPanelState(key, "settings");
    writeRightPanelState(key, "create-group");
    // An import is not reopened after a reload either.
    writeRightPanelState(key, "import-agent");
    expect(readRightPanelState(key)).toEqual({ panel: "settings" });
  });
  it("keeps a bot's last tab while its panel is closed, across reloads", () => {
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    });
    expect(readLastBotTab("bot-a")).toBe("computer");
    writeRightPanelState("bot-a", "pages");
    writeRightPanelState("bot-b", "settings");
    writeRightPanelState("bot-a", null);
    expect(readRightPanelState("bot-a")).toEqual({ panel: null });
    expect(readLastBotTab("bot-a")).toBe("pages");
    expect(readLastBotTab("bot-b")).toBe("settings");
    // A routine editor or group panel is not a tab and keeps the one before it.
    writeRightPanelState("bot-a", "routine", "routine-a");
    writeRightPanelState("bot-a", null);
    expect(readLastBotTab("bot-a")).toBe("pages");
  });
  it("falls back to the Computer tab with no key, no entry or unreadable storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => '{"panel":null,"tab":"unknown"}' });
    expect(readLastBotTab(null)).toBe("computer");
    expect(readLastBotTab("bot-a")).toBe("computer");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    });
    expect(readLastBotTab("bot-a")).toBe("computer");
  });
});
