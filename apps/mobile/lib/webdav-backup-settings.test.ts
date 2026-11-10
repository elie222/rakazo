import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItemAsync: vi.fn(async (key: string) => store.values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.values.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.values.delete(key);
  }),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: store.getItemAsync,
  setItemAsync: store.setItemAsync,
  deleteItemAsync: store.deleteItemAsync,
}));

// The real module requires PNG assets at the top level, which vitest cannot
// load; the settings code only needs the pack store, so it is faked here.
const packStore = vi.hoisted(() => ({ packs: {} as Record<string, string> }));
vi.mock("./expression-avatar", () => ({
  EXPRESSION_PACK_KEY: "rakazo.expression-pack",
  allExpressionPacks: () => ({ ...packStore.packs }),
  expressionPackFor: (botId?: string) => (botId ? (packStore.packs[botId] ?? "chief") : "chief"),
  setExpressionPack: (botId: string, pack: string) => {
    packStore.packs[botId] = pack;
  },
  useExpressionPack: (botId?: string) => (botId ? (packStore.packs[botId] ?? "chief") : "chief"),
}));

import { setChatBackground } from "./chat-background";
import { customSettingsFor, defaultCustomSettings } from "./custom-settings";
import { setExpressionPack } from "./expression-avatar";
import { setHeroBackground } from "./hero-background";
import { applyBackupSettingsFile, readBackupSettingsFile } from "./webdav-backup-settings";

beforeEach(() => {
  store.values.clear();
  packStore.packs = {};
});

describe("settings backup file", () => {
  it("reads the stored maps into the file format", async () => {
    store.values.set(
      "rakazo.chat-backgrounds",
      JSON.stringify({
        "thread-a": { kind: "url", uri: "https://img.example/x.png", opacity: 40 },
      }),
    );
    store.values.set(
      "rakazo.hero-backgrounds",
      JSON.stringify({
        "thread-a": { kind: "image", uri: "file:///doc/hero.jpg", opacity: 60 },
      }),
    );
    store.values.set(
      "rakazo.expression-pack",
      JSON.stringify({ bot1: "chief", bot2: "off", bot3: "chief" }),
    );
    const file = await readBackupSettingsFile("user-1");
    expect(file.version).toBe(1);
    expect(file.userId).toBe("user-1");
    expect(file.settings.chatBackgrounds).toEqual({
      "thread-a": { kind: "url", uri: "https://img.example/x.png", opacity: 40 },
    });
    expect(file.settings.heroBackground).toEqual({
      "thread-a": { kind: "image", uri: "file:///doc/hero.jpg", opacity: 60 },
    });
    // Two chiefs beat one off: the single file value follows the majority.
    expect(file.settings.expressionPack).toBe("chief");
    // No stored interface settings: the snapshot is the defaults.
    expect(file.settings.custom).toEqual(defaultCustomSettings());
    expect(JSON.stringify(file)).not.toMatch(/password|secret|token|webdav/i);
  });

  it("defaults to empty maps and the chief pack", async () => {
    const file = await readBackupSettingsFile("user-1");
    expect(file.settings.heroBackground).toBeNull();
    expect(file.settings.chatBackgrounds).toEqual({});
    expect(file.settings.expressionPack).toBe("chief");
  });

  it("applies a file back through the settings setters", async () => {
    const file = {
      version: 1,
      exportedAt: "2026-11-10T10:00:00.000Z",
      userId: "user-1",
      settings: {
        heroBackground: {
          "thread-b": { kind: "url", uri: "https://img.example/y.png", opacity: 30 },
        },
        chatBackgrounds: {
          "thread-b": { kind: "video", uri: "file:///doc/bg.mp4", opacity: 70 },
        },
        expressionPack: "off",
        custom: {},
      },
    };
    const applied = applyBackupSettingsFile(file, "user-1", "bot-9");
    expect(applied).toEqual(file);
    const reread = await readBackupSettingsFile("user-1");
    expect(reread.settings.chatBackgrounds["thread-b"]).toEqual({
      kind: "video",
      uri: "file:///doc/bg.mp4",
      opacity: 70,
    });
    expect(reread.settings.heroBackground?.["thread-b"]).toEqual({
      kind: "url",
      uri: "https://img.example/y.png",
      opacity: 30,
    });
    expect(reread.settings.expressionPack).toBe("off");
  });

  it("rejects a file that smuggles an extra settings key", () => {
    expect(() =>
      applyBackupSettingsFile(
        {
          version: 1,
          exportedAt: "2026-11-10T10:00:00.000Z",
          userId: "user-1",
          settings: {
            heroBackground: null,
            chatBackgrounds: {},
            expressionPack: "chief",
            custom: {},
            webdavPassword: "nope",
          },
        },
        "user-1",
      ),
    ).toThrow();
  });

  it("in-memory changes win over the stored snapshot", async () => {
    store.values.set(
      "rakazo.chat-backgrounds",
      JSON.stringify({
        "thread-c": { kind: "url", uri: "https://img.example/old.png", opacity: 40 },
      }),
    );
    setChatBackground("thread-c", { kind: "url", uri: "https://img.example/new.png", opacity: 45 });
    setHeroBackground("thread-c", { kind: "url", uri: "https://img.example/h.png", opacity: 50 });
    setExpressionPack("bot-1", "off");
    const file = await readBackupSettingsFile("user-1");
    expect(file.settings.chatBackgrounds["thread-c"]?.uri).toBe("https://img.example/new.png");
    expect(file.settings.heroBackground?.["thread-c"]?.uri).toBe("https://img.example/h.png");
    expect(file.settings.expressionPack).toBe("off");
  });

  it("carries the stored interface settings snapshot", async () => {
    store.values.set(
      "rakazo.custom-settings.user-1",
      JSON.stringify({
        heroBackgroundHeights: { "thread-d": 65 },
        chipsRowWidthPct: 80,
        chipsCardWidth: 64,
        font: {
          family: "system",
          title: { size: 19, color: "#2f6bff" },
          chat: { size: 16, color: null },
          error: { size: 13, color: "#c92a2a" },
          imported: [],
        },
        messageBackgrounds: { user: "#e8efff", ai: null, error: "#fde8e8" },
        messageActions: {
          order: ["copy", "share", "speak", "favorite", "regenerate"],
          hidden: ["favorite"],
        },
      }),
    );
    const file = await readBackupSettingsFile("user-1");
    expect(file.settings.custom).toMatchObject({
      heroBackgroundHeights: { "thread-d": 65 },
      chipsRowWidthPct: 80,
      chipsCardWidth: 64,
      messageBackgrounds: { user: "#e8efff", ai: null, error: "#fde8e8" },
      messageActions: { hidden: ["favorite"] },
    });
    expect(file.settings.custom.font).toMatchObject({ title: { size: 19, color: "#2f6bff" } });
  });

  it("restores the interface settings, and an empty custom leaves them alone", async () => {
    const base = {
      version: 1,
      exportedAt: "2026-11-10T10:00:00.000Z",
      userId: "user-1",
      settings: {
        heroBackground: null,
        chatBackgrounds: {},
        expressionPack: "chief",
        custom: {
          heroBackgroundHeights: { "thread-e": 70 },
          chipsRowWidthPct: 75,
          chipsCardWidth: 60,
          font: {
            family: "system",
            title: { size: 20, color: null },
            chat: { size: 18, color: null },
            error: { size: 15, color: "#c92a2a" },
            imported: [],
          },
          messageActions: {
            order: ["share", "copy", "speak", "favorite", "regenerate"],
            hidden: [],
          },
        },
      },
    };
    applyBackupSettingsFile(base, "user-1", "bot-9");
    expect(customSettingsFor("user-1").chipsRowWidthPct).toBe(75);
    expect(customSettingsFor("user-1").heroBackgroundHeights).toEqual({ "thread-e": 70 });
    expect(customSettingsFor("user-1").font.title.size).toBe(20);
    // An old file's empty custom never resets the settings that are already there.
    applyBackupSettingsFile({ ...base, settings: { ...base.settings, custom: {} } }, "user-1");
    expect(customSettingsFor("user-1").chipsRowWidthPct).toBe(75);
    expect(customSettingsFor("user-1").heroBackgroundHeights).toEqual({ "thread-e": 70 });
  });
});
