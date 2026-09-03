import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-localization", () => ({
  getLocales: vi.fn(() => [{ languageTag: "en-US" }]),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock("./ui-direction", () => ({
  applyMobileUiDirection: vi.fn(),
}));

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

describe("mobile i18n", () => {
  beforeEach(async () => {
    vi.resetModules();
    const { getItemAsync, setItemAsync } = await import("expo-secure-store");
    vi.mocked(getItemAsync).mockReset();
    vi.mocked(setItemAsync).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to the English source message when a translation is missing", async () => {
    const { resetI18nForTests, t } = await import("./i18n");
    resetI18nForTests("zh-CN");
    expect(t("Not a real string")).toBe("Not a real string");
  });

  it("translates seeded Chinese chrome and keeps interpolations", async () => {
    const { resetI18nForTests, t } = await import("./i18n");
    resetI18nForTests("zh-CN");
    expect(t("Account")).toBe("账户");
    expect(t("Sign in to Rakazo")).toBe("登录 Rakazo");
    expect(t("New bot")).toBe("新建 Bot");
    expect(t("{runs} runs · {tokens} tokens", { runs: 3, tokens: 12 })).toBe(
      "3 次运行 · 12 个 token",
    );
    expect(t("Delete {name}?", { name: "Scout" })).toBe("要删除 Scout 吗？");
  });

  it("preserves interpolations in the Chinese catalog", async () => {
    const { ZH_MESSAGES } = await import("./locales/zh");
    const empty = Object.entries(ZH_MESSAGES).filter(([, value]) => !value.trim());
    const interpolationMismatches = Object.entries(ZH_MESSAGES).filter(([id, value]) => {
      const tokens = (message: string) =>
        [...message.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort();
      return JSON.stringify(tokens(id)) !== JSON.stringify(tokens(value));
    });
    expect(empty).toEqual([]);
    expect(interpolationMismatches).toEqual([]);
  });

  it("translates every mobile chrome t() id", async () => {
    const { ZH_MESSAGES } = await import("./locales/zh");
    const { EMPTY_PLUGIN_CATALOG_MESSAGE, SLASH_ACTIONS } = await import("@rakazo/core");
    const { OPENAI_COMPATIBLE_BASE_URL_HINT } = await import("@rakazo/contracts");
    const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const ids = new Set<string>([
      EMPTY_PLUGIN_CATALOG_MESSAGE,
      OPENAI_COMPATIBLE_BASE_URL_HINT,
      ...SLASH_ACTIONS.map((action) => action.label),
      "Sign-in did not return a session",
      "Sign-up did not return a session",
      "{count} model",
      "{count} models",
    ]);
    for (const file of collectSourceFiles(mobileRoot)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bt\(\s*"((?:\\.|[^"\\])*)"/g)) {
        ids.add(JSON.parse(`"${match[1]}"`) as string);
      }
    }
    const missing = [...ids].filter((id) => !ZH_MESSAGES[id]?.trim()).sort();
    expect(missing).toEqual([]);
  });

  it("prefers the stored locale, then activates and persists a new choice", async () => {
    const { getItemAsync, setItemAsync } = await import("expo-secure-store");
    vi.mocked(getItemAsync).mockResolvedValue("zh-CN");
    const { applyMobileUiDirection } = await import("./ui-direction");
    const { bootstrapI18n, getActiveUiLocale, setUiLocale, t } = await import("./i18n");

    await expect(bootstrapI18n()).resolves.toBe("zh-CN");
    expect(getActiveUiLocale()).toBe("zh-CN");
    expect(t("Language")).toBe("语言");
    expect(applyMobileUiDirection).toHaveBeenCalledWith("zh-CN");

    await setUiLocale("en");
    expect(getActiveUiLocale()).toBe("en");
    expect(t("Language")).toBe("Language");
    expect(setItemAsync).toHaveBeenCalledWith("rakazo.uiLocale", "en");
    expect(applyMobileUiDirection).toHaveBeenCalledWith("en");
  });

  it("keeps the last locale when rapid setUiLocale calls finish out of order", async () => {
    const { setItemAsync } = await import("expo-secure-store");
    const { applyMobileUiDirection } = await import("./ui-direction");
    const { getActiveUiLocale, resetI18nForTests, setUiLocale } = await import("./i18n");
    resetI18nForTests("en");

    const gates = new Map<string, { release: () => void; wait: Promise<void> }>();
    for (const locale of ["en", "zh-CN"] as const) {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.set(locale, { release, wait });
    }
    vi.mocked(setItemAsync).mockImplementation(async (_key, value) => {
      await gates.get(String(value))?.wait;
    });

    const first = setUiLocale("en");
    const second = setUiLocale("zh-CN");
    // First write is slower to settle; second must still win after the queue drains.
    queueMicrotask(() => gates.get("zh-CN")?.release());
    queueMicrotask(() => gates.get("en")?.release());
    await Promise.all([first, second]);

    expect(getActiveUiLocale()).toBe("zh-CN");
    expect(setItemAsync).toHaveBeenLastCalledWith("rakazo.uiLocale", "zh-CN");
    expect(applyMobileUiDirection).toHaveBeenLastCalledWith("zh-CN");
  });
});
