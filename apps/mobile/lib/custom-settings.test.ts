// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomSettings } from "./custom-settings";

const store = vi.hoisted(() => ({
  stored: null as string | null,
  getItemAsync: vi.fn(async () => store.stored),
  setItemAsync: vi.fn(async (_key: string, value: string) => {
    store.stored = value;
  }),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: store.getItemAsync,
  setItemAsync: store.setItemAsync,
}));

const fsMocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
}));

vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(parent: string | Directory, name?: string) {
      const base = typeof parent === "string" ? parent : parent.uri;
      this.uri = name === undefined ? base : `${base}/${name}`;
    }
    get exists() {
      return fsMocks.dirs.has(this.uri);
    }
    create() {
      fsMocks.dirs.add(this.uri);
    }
  }
  class File {
    uri: string;
    constructor(first: string | Directory, second?: string) {
      const base = typeof first === "string" ? first : first.uri;
      this.uri = second === undefined ? base : `${base}/${second}`;
    }
    get name() {
      return this.uri.split("/").pop() ?? "";
    }
    get exists() {
      return fsMocks.files.has(this.uri);
    }
    async copy(destination: File) {
      fsMocks.files.set(destination.uri, "copied");
    }
    delete() {
      fsMocks.files.delete(this.uri);
    }
  }
  return {
    Directory,
    File,
    Paths: { document: "file:///doc", cache: "file:///cache" },
  };
});

const fontMocks = vi.hoisted(() => ({
  loadAsync: vi.fn(async () => undefined),
}));

vi.mock("expo-font", () => ({
  loadAsync: fontMocks.loadAsync,
}));

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (condition()) return;
  }
  throw new Error("timed out waiting for the store to settle");
}

/**
 * The store persists fire-and-forget; a test that mutates it must drain its
 * saves before the next test, or a late save overwrites the next test's
 * stored snapshot.
 */
async function waitForSaves(count: number) {
  await waitFor(() => store.setItemAsync.mock.calls.length >= count);
}

describe("custom settings", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    store.stored = null;
    store.getItemAsync.mockClear();
    store.setItemAsync.mockClear();
    fsMocks.files.clear();
    fsMocks.dirs.clear();
    fontMocks.loadAsync.mockClear();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
  });

  async function mountSettingsProbe(userId: string) {
    const mod = await import("./custom-settings");
    let seen = mod.customSettingsFor(userId);
    function Probe() {
      seen = mod.useCustomSettings(userId);
      return null;
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(createElement(Probe));
    });
    return { mod, seen: () => seen };
  }

  it("starts from the defaults", async () => {
    const { customSettingsFor, defaultCustomSettings } = await import("./custom-settings");
    expect(customSettingsFor("user-1")).toEqual(defaultCustomSettings());
    expect(defaultCustomSettings()).toMatchObject({
      heroBackgroundWidths: {},
      chipsRowWidthPct: 100,
      chipsCardWidth: 72,
      messageActions: {
        order: ["copy", "speak", "share", "favorite", "regenerate"],
        hidden: [],
      },
    });
    expect(defaultCustomSettings().font).toMatchObject({
      family: "system",
      title: { size: 17, color: null },
      chat: { size: 17, color: null },
      error: { size: 14, color: "#e5484d" },
    });
  });

  it("merges patches and clamps out-of-range values", async () => {
    const { customSettingsFor, setCustomSettings } = await import("./custom-settings");
    setCustomSettings("user-1", { chipsRowWidthPct: 200, chipsCardWidth: 10 });
    expect(customSettingsFor("user-1")).toMatchObject({
      chipsRowWidthPct: 100,
      chipsCardWidth: 56,
    });
    setCustomSettings("user-1", {
      font: { title: { size: 100, color: "not-a-color" }, chat: { size: 10, color: "#2F6BFF" } },
    });
    expect(customSettingsFor("user-1").font.title).toEqual({ size: 24, color: null });
    expect(customSettingsFor("user-1").font.chat).toEqual({ size: 14, color: "#2f6bff" });
    // A patch leaves the untouched slots alone.
    expect(customSettingsFor("user-1").font.error).toEqual({ size: 14, color: "#e5484d" });
    await waitForSaves(2);
  });

  it("parses a stored or restored object strictly", async () => {
    const { parseCustomSettings } = await import("./custom-settings");
    const parsed = parseCustomSettings({
      heroBackgroundWidths: { "bot-1": 80, "bot-2": 5, "bot-3": "wide" },
      chipsRowWidthPct: "narrow",
      font: {
        family: "Ghost Font",
        title: { size: 20, color: "#111111" },
        imported: [
          { id: "f1", family: "Ghost Font", fileName: "Ghost.ttf", uri: "file:///doc/x.ttf" },
        ],
      },
      messageActions: {
        order: ["share", "copy", "copy", "explode", "favorite"],
        hidden: ["favorite", "explode"],
      },
      unknownField: true,
    });
    expect(parsed.heroBackgroundWidths).toEqual({ "bot-1": 80, "bot-2": 60, "bot-3": 100 });
    expect(parsed.chipsRowWidthPct).toBe(100);
    // The family survives because it is in the imported list.
    expect(parsed.font.family).toBe("Ghost Font");
    // The order keeps the stored order for known actions, drops the unknown
    // one and the duplicate, and appends the missing actions at the end.
    expect(parsed.messageActions.order).toEqual([
      "share",
      "copy",
      "favorite",
      "speak",
      "regenerate",
    ]);
    expect(parsed.messageActions.hidden).toEqual(["favorite"]);
    expect(parsed).not.toHaveProperty("unknownField");
  });

  it("falls back to the system font when the family is not imported", async () => {
    const { parseCustomSettings } = await import("./custom-settings");
    expect(parseCustomSettings({ font: { family: "Ghost Font", imported: [] } }).font.family).toBe(
      "system",
    );
    expect(parseCustomSettings(null)).toEqual(parseCustomSettings(undefined));
    expect(parseCustomSettings([]).chipsCardWidth).toBe(72);
  });

  it("keeps each thread's hero width apart", async () => {
    const { customSettingsFor, heroBackgroundWidthFor, setHeroBackgroundWidth } = await import(
      "./custom-settings"
    );
    expect(heroBackgroundWidthFor(customSettingsFor("user-1"), "bot-1")).toBe(100);
    setHeroBackgroundWidth("user-1", "bot-1", 70);
    setHeroBackgroundWidth("user-1", "bot-2", 200);
    expect(heroBackgroundWidthFor(customSettingsFor("user-1"), "bot-1")).toBe(70);
    expect(heroBackgroundWidthFor(customSettingsFor("user-1"), "bot-2")).toBe(100);
    expect(heroBackgroundWidthFor(customSettingsFor("user-1"), undefined)).toBe(100);
    await waitForSaves(2);
  });

  it("keeps each account's settings apart", async () => {
    const { customSettingsFor, setCustomSettings } = await import("./custom-settings");
    setCustomSettings("user-1", { chipsRowWidthPct: 60 });
    expect(customSettingsFor("user-1").chipsRowWidthPct).toBe(60);
    expect(customSettingsFor("user-2").chipsRowWidthPct).toBe(100);
    await waitForSaves(1);
  });

  it("loads stored settings and persists changes", async () => {
    store.stored = JSON.stringify({
      heroBackgroundWidths: { "bot-1": 75 },
      chipsRowWidthPct: 80,
      chipsCardWidth: 64,
      font: {
        family: "system",
        title: { size: 19, color: "#2f6bff" },
        chat: { size: 16, color: null },
        error: { size: 13, color: "#c92a2a" },
        imported: [],
      },
      messageActions: { order: ["copy", "share", "speak", "favorite", "regenerate"], hidden: [] },
    });
    const { mod, seen } = await mountSettingsProbe("user-1");
    await waitFor(() => seen().chipsRowWidthPct === 80);
    expect(seen().heroBackgroundWidths).toEqual({ "bot-1": 75 });
    expect(seen().font.title).toEqual({ size: 19, color: "#2f6bff" });
    mod.setHeroBackgroundWidth("user-1", "bot-1", 65);
    // The mounted hook re-renders at once, before the persist lands.
    await waitFor(() => seen().heroBackgroundWidths["bot-1"] === 65);
    await waitFor(() => store.setItemAsync.mock.calls.length > 0);
    expect(store.setItemAsync).toHaveBeenCalledWith(
      "rakazo.custom-settings.user-1",
      expect.stringContaining("65"),
    );
  });

  it("orders and hides message actions against a message's capabilities", async () => {
    const { defaultCustomSettings, visibleMessageActions } = await import("./custom-settings");
    const settings = defaultCustomSettings();
    expect(visibleMessageActions(settings, {})).toEqual([
      "copy",
      "speak",
      "share",
      "favorite",
      "regenerate",
    ]);
    // A message that cannot speak and has no favorite handler loses both tiles.
    expect(visibleMessageActions(settings, { speak: false, favorite: false })).toEqual([
      "copy",
      "share",
      "regenerate",
    ]);
    const hidden: CustomSettings = {
      ...settings,
      messageActions: {
        order: ["share", "copy", "favorite", "speak", "regenerate"],
        hidden: ["share"],
      },
    };
    expect(visibleMessageActions(hidden, {})).toEqual(["copy", "favorite", "speak", "regenerate"]);
  });

  it("scales line height with the font size", async () => {
    const { scaledLineHeight } = await import("./custom-settings");
    expect(scaledLineHeight(17)).toBe(22);
    expect(scaledLineHeight(24)).toBe(31);
    expect(scaledLineHeight(14)).toBe(18);
  });

  it("imports a picked font and selects it at once", async () => {
    const { customSettingsFor, importCustomFont } = await import("./custom-settings");
    const entry = await importCustomFont("user-1", "file:///tmp/pick.ttf", "My Font.ttf");
    expect(entry).toMatchObject({ family: "My Font", fileName: "My Font.ttf" });
    expect(entry?.uri).toBe("file:///doc/custom-fonts/My Font.ttf");
    expect(fsMocks.files.has("file:///doc/custom-fonts/My Font.ttf")).toBe(true);
    expect(customSettingsFor("user-1").font.family).toBe("My Font");
    expect(customSettingsFor("user-1").font.imported).toHaveLength(1);
    await waitFor(() => fontMocks.loadAsync.mock.calls.length > 0);
    expect(fontMocks.loadAsync).toHaveBeenCalledWith({
      "My Font": "file:///doc/custom-fonts/My Font.ttf",
    });
    await waitForSaves(1);
  });

  it("refuses anything that is not a font file", async () => {
    const { customSettingsFor, importCustomFont } = await import("./custom-settings");
    expect(await importCustomFont("user-1", "file:///tmp/pick.png", "Photo.png")).toBeNull();
    expect(await importCustomFont("user-1", "file:///tmp/pick.ttf", "NoExt")).toBeNull();
    expect(customSettingsFor("user-1").font.imported).toHaveLength(0);
    expect(fontMocks.loadAsync).not.toHaveBeenCalled();
  });

  it("replaces a same-family font and removes one", async () => {
    const { customSettingsFor, importCustomFont, removeImportedFont } = await import(
      "./custom-settings"
    );
    const first = await importCustomFont("user-1", "file:///tmp/a.ttf", "My Font.ttf");
    const second = await importCustomFont("user-1", "file:///tmp/b.ttf", "My Font.ttf");
    expect(second?.id).toBe(first?.id);
    expect(customSettingsFor("user-1").font.imported).toHaveLength(1);
    removeImportedFont("user-1", second!.id);
    expect(customSettingsFor("user-1").font.imported).toHaveLength(0);
    // The active family falls back to the system font with the font.
    expect(customSettingsFor("user-1").font.family).toBe("system");
    await waitForSaves(3);
  });

  it("restores settings wholesale and parses them strictly", async () => {
    const { applyCustomSettings, customSettingsFor } = await import("./custom-settings");
    applyCustomSettings("user-1", {
      chipsRowWidthPct: 70,
      font: { title: { size: 22, color: "#111111" } },
      messageActions: { hidden: ["favorite"] },
    });
    const restored = customSettingsFor("user-1");
    expect(restored.chipsRowWidthPct).toBe(70);
    expect(restored.font.title).toEqual({ size: 22, color: "#111111" });
    expect(restored.messageActions.hidden).toEqual(["favorite"]);
    // The slots the file never mentioned keep their defaults.
    expect(restored.font.chat).toEqual({ size: 17, color: null });
    await waitForSaves(1);
  });
});
