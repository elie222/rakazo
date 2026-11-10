import { generateMessageId } from "@lingui/message-utils/generateMessageId";
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

/**
 * Looks a message up the way the compiled macro does, in the Lingui instance the freshly imported
 * `./i18n` loaded its catalogs into.
 */
async function translator() {
  const { i18n } = await import("@lingui/core");
  return (message: string, values?: Record<string, unknown>) =>
    i18n._({ id: generateMessageId(message), message, values });
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
    vi.unstubAllGlobals();
  });

  it("falls back to the English source message when a translation is missing", async () => {
    const { resetI18nForTests } = await import("./i18n");
    const t = await translator();
    resetI18nForTests("zh-CN");
    expect(t("Not a real string")).toBe("Not a real string");
    expect(t("Not a real {thing}", { thing: "string" })).toBe("Not a real string");
  });

  it.each([
    ["zh-CN", "账户", "要删除 Scout 吗？"],
    ["zh-TW", "帳號", "要刪除 Scout 嗎？"],
    ["ru", "Аккаунт", "Удалить Scout?"],
    ["de", "Konto", "Scout löschen?"],
    ["pl", "Konto", "Usunąć Scout?"],
  ] as const)(
    "translates from the shared %s catalog and keeps interpolations",
    async (locale, account, del) => {
      const { dateLocaleForUi, resetI18nForTests } = await import("./i18n");
      const t = await translator();
      resetI18nForTests(locale);
      expect(t("Account")).toBe(account);
      expect(t("Delete {name}?", { name: "Scout" })).toBe(del);
      expect(dateLocaleForUi()).toBe(locale);
    },
  );

  it.each([
    [1, "1 сообщение с Scout"],
    [2, "2 сообщения с Scout"],
    [5, "5 сообщений с Scout"],
    [21, "21 сообщение с Scout"],
  ] as const)(
    "picks the Russian plural for %s messages without Intl.PluralRules",
    async (count, label) => {
      // Hermes: every Intl API but PluralRules.
      vi.stubGlobal("Intl", Object.assign(Object.create(Intl), { PluralRules: undefined }));
      const { resetI18nForTests } = await import("./i18n");
      const t = await translator();
      resetI18nForTests("ru");
      expect(
        t("{count, plural, one {# message with {peer}} other {# messages with {peer}}}", {
          count,
          peer: "Scout",
        }),
      ).toBe(label);
    },
  );

  it("prefers the stored locale, then activates and persists a new choice", async () => {
    const { getItemAsync, setItemAsync } = await import("expo-secure-store");
    vi.mocked(getItemAsync).mockResolvedValue("zh-CN");
    const { applyMobileUiDirection } = await import("./ui-direction");
    const { bootstrapI18n, getActiveUiLocale, setUiLocale } = await import("./i18n");
    const t = await translator();

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

  it("restores Polish from a regional stored locale and persists a new choice", async () => {
    const { getItemAsync, setItemAsync } = await import("expo-secure-store");
    const { applyMobileUiDirection } = await import("./ui-direction");
    const { bootstrapI18n, getActiveUiLocale, setUiLocale } = await import("./i18n");
    vi.mocked(getItemAsync).mockResolvedValue("pl-PL");
    await expect(bootstrapI18n()).resolves.toBe("pl");
    expect(getActiveUiLocale()).toBe("pl");
    expect(applyMobileUiDirection).toHaveBeenLastCalledWith("pl");
    await setUiLocale("en");
    await setUiLocale("pl");
    expect(setItemAsync).toHaveBeenLastCalledWith("rakazo.uiLocale", "pl");
    expect(getActiveUiLocale()).toBe("pl");
  });

  it("normalizes a regional Russian stored locale before activation", async () => {
    const { getItemAsync } = await import("expo-secure-store");
    vi.mocked(getItemAsync).mockResolvedValue("ru-RU");
    const { bootstrapI18n, dateLocaleForUi, getActiveUiLocale } = await import("./i18n");
    const t = await translator();

    await expect(bootstrapI18n()).resolves.toBe("ru");
    expect(getActiveUiLocale()).toBe("ru");
    expect(t("Language")).toBe("Язык");
    expect(dateLocaleForUi()).toBe("ru");
  });

  it("normalizes a regional German stored locale before activation", async () => {
    const { getItemAsync } = await import("expo-secure-store");
    vi.mocked(getItemAsync).mockResolvedValue("de-CH");
    const { bootstrapI18n, dateLocaleForUi, getActiveUiLocale } = await import("./i18n");
    const t = await translator();

    await expect(bootstrapI18n()).resolves.toBe("de");
    expect(getActiveUiLocale()).toBe("de");
    expect(t("Language")).toBe("Sprache");
    expect(dateLocaleForUi()).toBe("de");
  });

  it("keeps the last locale when rapid setUiLocale calls finish out of order", async () => {
    const { setItemAsync } = await import("expo-secure-store");
    const { applyMobileUiDirection } = await import("./ui-direction");
    const { getActiveUiLocale, resetI18nForTests, setUiLocale } = await import("./i18n");
    resetI18nForTests("en");

    const gates = new Map<string, { release: () => void; wait: Promise<void> }>();
    for (const locale of ["en", "zh-CN", "ru", "de"] as const) {
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

describe("plural rules without Intl.PluralRules", () => {
  it.each([
    [0, "many"],
    [1, "one"],
    [2, "few"],
    [4, "few"],
    [5, "many"],
    [12, "many"],
    [14, "many"],
    [21, "many"],
    [22, "few"],
    [25, "many"],
    [101, "many"],
    [112, "many"],
    [122, "few"],
  ] as const)("picks the Polish form for %s: %s", async (count, form) => {
    const { pluralCategory } = await import("./plural-rules");
    expect(pluralCategory("pl", count)).toBe(form);
  });

  it.each([
    [1, "one"],
    [2, "few"],
    [5, "many"],
    [11, "many"],
    [21, "one"],
    [22, "few"],
    [111, "many"],
  ] as const)("picks the Russian form for %s: %s", async (count, form) => {
    const { pluralCategory } = await import("./plural-rules");
    expect(pluralCategory("ru", count)).toBe(form);
  });

  it("reads Chinese and Japanese as one form and English-like languages as one or other", async () => {
    const { pluralCategory } = await import("./plural-rules");
    expect(pluralCategory("zh-CN", 1)).toBe("other");
    expect(pluralCategory("ja", 3)).toBe("other");
    expect(pluralCategory("de", 1)).toBe("one");
    expect(pluralCategory("es", 2)).toBe("other");
  });

  it("picks the same whole-number form as Intl.PluralRules in every shipped language", async () => {
    const { pluralCategory } = await import("./plural-rules");
    const { UI_LOCALES } = await import("./ui-locale");
    for (const locale of UI_LOCALES) {
      const rules = new Intl.PluralRules(locale);
      for (let count = 0; count <= 120; count++) {
        expect(pluralCategory(locale, count), `${locale} ${count}`).toBe(rules.select(count));
      }
    }
  });

  it("fills in Intl.PluralRules only where it is missing, and reads fractions as other", async () => {
    const native = Intl.PluralRules;
    const { installPluralRules } = await import("./plural-rules");
    installPluralRules();
    expect(Intl.PluralRules).toBe(native);
    // Hermes: every Intl API but PluralRules.
    vi.stubGlobal("Intl", Object.assign(Object.create(Intl), { PluralRules: undefined }));
    installPluralRules();
    expect(new Intl.PluralRules("pl").select(22)).toBe("few");
    expect(new Intl.PluralRules(["ru"]).select(1.5)).toBe("other");
    expect(new Intl.PluralRules("ru", { type: "ordinal" }).select(1)).toBe("other");
    vi.unstubAllGlobals();
  });
});

it("restores Traditional Chinese after saving the language choice", async () => {
  const { getItemAsync, setItemAsync } = await import("expo-secure-store");
  const { applyMobileUiDirection } = await import("./ui-direction");
  const { bootstrapI18n, dateLocaleForUi, resetI18nForTests, setUiLocale } = await import("./i18n");
  const t = await translator();
  await setUiLocale("zh-TW");
  expect(setItemAsync).toHaveBeenLastCalledWith("rakazo.uiLocale", "zh-TW");
  resetI18nForTests();
  vi.mocked(getItemAsync).mockResolvedValue("zh-TW");
  await expect(bootstrapI18n()).resolves.toBe("zh-TW");
  expect(dateLocaleForUi()).toBe("zh-TW");
  expect(applyMobileUiDirection).toHaveBeenLastCalledWith("zh-TW");
  expect(t("Language")).toBe("語言");
  expect(t("Delete {name}?", { name: "Scout" })).toBe("要刪除 Scout 嗎？");
});
