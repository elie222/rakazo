import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const schemeListeners = new Set<(event: { colorScheme: "light" | "dark" | null }) => void>();
let colorScheme: "light" | "dark" | null = "dark";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
}));

vi.mock("react-native", () => ({
  Appearance: {
    getColorScheme: () => colorScheme,
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
    const darkBubble = mobileTokens("dark").secondary;
    const darkInk = mobileTokens("dark").secondaryForeground;

    await setAppearancePreference("light");
    expect(listener).toHaveBeenCalled();
    // Same path memoized bubbles use after useResolvedAppearance invalidates.
    expect(mobileTokens("light").secondary).not.toBe(darkBubble);
    expect(mobileTokens("light").secondaryForeground).not.toBe(darkInk);
    expect(mobileTokens("light").secondary).not.toBe(mobileTokens("light").primary);
  });
});
