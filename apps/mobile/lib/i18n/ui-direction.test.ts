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
    expect(I18nManager.allowRTL).toHaveBeenCalledWith(false);
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

  it("defaults to LTR English so a no-arg call cannot fight zh/en/ru/de UI locale bootstrap", async () => {
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

  // React Native's native rule (I18nUtil.isRTL on Android) is forced || (allowed && device
  // language is RTL), read once per start; allowRTL and forceRTL are saved and apply from the
  // next start.
  it("reloads at most once on an RTL phone whose language has no UI locale", async () => {
    const saved = { allowed: true, forced: false }; // React Native's defaults
    const deviceLanguageRtl = true;
    let reloads = 0;
    for (let start = 0; start < 4; start++) {
      vi.resetModules();
      vi.clearAllMocks();
      const { I18nManager } = await import("react-native");
      const { reloadAppAsync } = await import("expo");
      const native = I18nManager as unknown as {
        isRTL: boolean;
        allowRTL: ReturnType<typeof vi.fn>;
        forceRTL: ReturnType<typeof vi.fn>;
      };
      native.isRTL = saved.forced || (saved.allowed && deviceLanguageRtl);
      native.allowRTL.mockImplementation((value: boolean) => {
        saved.allowed = value;
      });
      native.forceRTL.mockImplementation((value: boolean) => {
        saved.forced = value;
      });
      const { applyMobileUiDirection } = await import("./ui-direction");

      // The phone's language is RTL, but the UI resolves to English.
      expect(applyMobileUiDirection("en")).toBe(false);
      await Promise.resolve();
      reloads += vi.mocked(reloadAppAsync).mock.calls.length;
    }
    expect(reloads).toBe(1);
    expect(saved).toEqual({ allowed: false, forced: false });
  });

  it("still lays out right to left when the UI locale is RTL on that phone", async () => {
    const { I18nManager } = await import("react-native");
    (I18nManager as { isRTL: boolean }).isRTL = false;
    const { applyMobileUiDirection } = await import("./ui-direction");

    expect(applyMobileUiDirection("he")).toBe(true);
    expect(I18nManager.allowRTL).toHaveBeenCalledWith(true);
    expect(I18nManager.forceRTL).toHaveBeenCalledWith(true);
  });
});
