import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo", () => ({
  reloadAppAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("react-native", () => ({
  I18nManager: {
    allowRTL: vi.fn(),
    forceRTL: vi.fn(),
    isRTL: false,
  },
  Platform: { OS: "ios" },
}));

describe("mobile ui direction", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("resolves a locale tag from Intl", async () => {
    const resolvedOptions = vi.fn().mockReturnValue({ locale: "he-IL" });
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: vi.fn().mockImplementation(() => ({ resolvedOptions })),
    });
    const { resolveMobileUiLocale } = await import("./ui-direction");

    expect(resolveMobileUiLocale()).toBe("he-IL");
  });

  it("forces rtl and reloads when the runtime is still ltr", async () => {
    const { I18nManager } = await import("react-native");
    const { reloadAppAsync } = await import("expo");
    (I18nManager as { isRTL: boolean }).isRTL = false;
    const { applyMobileUiDirection } = await import("./ui-direction");

    expect(applyMobileUiDirection("he-IL")).toBe(true);
    expect(I18nManager.allowRTL).toHaveBeenCalledWith(true);
    expect(I18nManager.forceRTL).toHaveBeenCalledWith(true);
    await Promise.resolve();
    expect(reloadAppAsync).toHaveBeenCalledWith("ui-direction");
  });

  it("forces ltr and reloads when the runtime is still rtl", async () => {
    const { I18nManager } = await import("react-native");
    const { reloadAppAsync } = await import("expo");
    (I18nManager as { isRTL: boolean }).isRTL = true;
    const { applyMobileUiDirection } = await import("./ui-direction");

    expect(applyMobileUiDirection("en-US")).toBe(false);
    expect(I18nManager.allowRTL).toHaveBeenCalledWith(true);
    expect(I18nManager.forceRTL).toHaveBeenCalledWith(false);
    await Promise.resolve();
    expect(reloadAppAsync).toHaveBeenCalledWith("ui-direction");
  });

  it("skips forceRTL and reload when layout already matches the locale", async () => {
    const { I18nManager } = await import("react-native");
    const { reloadAppAsync } = await import("expo");
    (I18nManager as { isRTL: boolean }).isRTL = true;
    const { applyMobileUiDirection } = await import("./ui-direction");

    expect(applyMobileUiDirection("he-IL")).toBe(true);
    expect(I18nManager.allowRTL).toHaveBeenCalledWith(true);
    expect(I18nManager.forceRTL).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(reloadAppAsync).not.toHaveBeenCalled();
  });

  it("defaults to LTR English so a no-arg call cannot fight zh/en UI locale bootstrap", async () => {
    const resolvedOptions = vi.fn().mockReturnValue({ locale: "ar-SA" });
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: vi.fn().mockImplementation(() => ({ resolvedOptions })),
    });
    const { I18nManager } = await import("react-native");
    const { reloadAppAsync } = await import("expo");
    (I18nManager as { isRTL: boolean }).isRTL = true;
    const { applyMobileUiDirection } = await import("./ui-direction");

    expect(applyMobileUiDirection()).toBe(false);
    expect(I18nManager.forceRTL).toHaveBeenCalledWith(false);
    await Promise.resolve();
    expect(reloadAppAsync).toHaveBeenCalledWith("ui-direction");
  });

  it("keeps root layout from applying device-locale direction before i18n bootstrap", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const layout = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../app/_layout.tsx"),
      "utf8",
    );
    expect(layout).not.toMatch(/applyMobileUiDirection\s*\(/);
  });
});
