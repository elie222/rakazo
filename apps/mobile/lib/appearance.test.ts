import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const schemeListeners = new Set<(event: { colorScheme: "light" | "dark" | null }) => void>();
let colorScheme: "light" | "dark" | null = "dark";
let colorSchemeOverride: "light" | "dark" | null = null;

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
}));

vi.mock("react-native", () => ({
  Appearance: {
    getColorScheme: () => colorSchemeOverride ?? colorScheme,
    setColorScheme: (scheme: "light" | "dark" | "unspecified") => {
      colorSchemeOverride = scheme === "unspecified" ? null : scheme;
    },
    addChangeListener: (listener: (event: { colorScheme: "light" | "dark" | null }) => void) => {
      schemeListeners.add(listener);
      return {
        remove() {
          schemeListeners.delete(listener);
        },
      };
    },
  },
}));

describe("mobile appearance", () => {
  beforeEach(() => {
    store.clear();
    schemeListeners.clear();
    colorScheme = "dark";
    colorSchemeOverride = null;
    vi.resetModules();
  });

  it("defaults to system and resolves light or dark from the scheme", async () => {
    const { getCachedAppearancePreference, resolveMobileAppearance, setAppearancePreference } =
      await import("./appearance");
    expect(getCachedAppearancePreference()).toBe("system");
    expect(resolveMobileAppearance("system", "light")).toBe("light");
    expect(resolveMobileAppearance("system", "dark")).toBe("dark");
    await setAppearancePreference("light");
    expect(getCachedAppearancePreference()).toBe("light");
    expect(resolveMobileAppearance("light", "dark")).toBe("light");
    await setAppearancePreference("system");
  });

  it("overrides the native scheme for an explicit choice and hands it back for System", async () => {
    const { UI_APPEARANCE_STORAGE_KEY } = await import("@rakazo/ui-tokens");
    const { loadAppearancePreference, resolveMobileAppearance, setAppearancePreference } =
      await import("./appearance");
    colorScheme = "light";

    await setAppearancePreference("dark");
    expect(colorSchemeOverride).toBe("dark");

    await setAppearancePreference("system");
    expect(colorSchemeOverride).toBeNull();
    expect(resolveMobileAppearance()).toBe("light");

    store.set(UI_APPEARANCE_STORAGE_KEY, "light");
    colorScheme = "dark";
    await loadAppearancePreference();
    expect(colorSchemeOverride).toBe("light");
  });

  it("notifies mounted navigation when the saved preference loads", async () => {
    const { UI_APPEARANCE_STORAGE_KEY, lightTokens } = await import("@rakazo/ui-tokens");
    const { loadAppearancePreference, mobileTokens, subscribeAppearance } = await import(
      "./appearance"
    );
    store.set(UI_APPEARANCE_STORAGE_KEY, "light");
    const listener = vi.fn();
    subscribeAppearance(listener);

    await loadAppearancePreference();

    expect(listener).toHaveBeenCalledOnce();
    expect(mobileTokens()).toEqual(lightTokens);
  });

  it("notifies subscribers when the OS scheme flips under System preference", async () => {
    const { resolveMobileAppearance, subscribeAppearance } = await import("./appearance");
    const listener = vi.fn();
    subscribeAppearance(listener);

    expect(resolveMobileAppearance()).toBe("dark");
    colorScheme = "light";
    for (const notify of schemeListeners) notify({ colorScheme: "light" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(resolveMobileAppearance()).toBe("light");
  });

  it("flips user bubble tokens when appearance switches with an existing preference", async () => {
    const { mobileTokens, setAppearancePreference, subscribeAppearance } = await import(
      "./appearance"
    );
    const listener = vi.fn();
    subscribeAppearance(listener);

    await setAppearancePreference("dark");
    const darkBubble = mobileTokens().secondary;
    const darkInk = mobileTokens().secondaryForeground;

    listener.mockClear();
    await setAppearancePreference("light");
    expect(listener).toHaveBeenCalledOnce();
    expect(mobileTokens().secondary).not.toBe(darkBubble);
    expect(mobileTokens().secondaryForeground).not.toBe(darkInk);
    expect(mobileTokens().secondary).not.toBe(mobileTokens().primary);
  });

  it("keeps the latest native scheme and stored preference when writes overlap", async () => {
    const { UI_APPEARANCE_STORAGE_KEY } = await import("@rakazo/ui-tokens");
    const { setItemAsync } = await import("expo-secure-store");
    const { getCachedAppearancePreference, setAppearancePreference } = await import("./appearance");
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let writes = 0;
    vi.mocked(setItemAsync).mockImplementation(async (key: string, value: string) => {
      writes += 1;
      if (writes === 1) await firstWrite;
      store.set(key, value);
    });

    try {
      const first = setAppearancePreference("light");
      const second = setAppearancePreference("dark");
      expect(getCachedAppearancePreference()).toBe("dark");
      expect(colorSchemeOverride).toBe("dark");

      releaseFirst();
      await Promise.all([first, second]);

      expect(colorSchemeOverride).toBe("dark");
      expect(getCachedAppearancePreference()).toBe("dark");
      expect(store.get(UI_APPEARANCE_STORAGE_KEY)).toBe("dark");
    } finally {
      vi.mocked(setItemAsync).mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
      });
    }
  });
});
