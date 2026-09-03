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
});
