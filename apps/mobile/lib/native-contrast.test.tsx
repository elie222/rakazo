import { beforeEach, describe, expect, it, vi } from "vitest";

const appearance = vi.hoisted(() => ({
  preference: "system" as "system" | "light" | "dark",
  resolved: "dark" as "dark" | "light",
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  PlatformColor: (name: string) => `platform:${name}`,
}));

vi.mock("./appearance", () => ({
  getCachedAppearancePreference: () => appearance.preference,
  mobileTokens: () => ({
    background: "token-background",
    card: "token-card",
    muted: "token-muted",
  }),
  resolveMobileAppearance: () => appearance.resolved,
  subscribeAppearance: () => () => undefined,
}));

import { native } from "./native";

describe("grouped colours", () => {
  beforeEach(() => {
    appearance.preference = "system";
    appearance.resolved = "dark";
  });

  it("uses the token page and card in dark, so red text keeps 4.5:1 inside sheets", () => {
    expect(native.groupedPage).toBe("token-background");
    expect(native.groupedCell).toBe("token-card");

    appearance.preference = "dark";
    expect(native.groupedPage).toBe("token-background");
    expect(native.groupedCell).toBe("token-card");
  });

  it("keeps the system grouped colours in light and the tokens when Light is forced", () => {
    appearance.resolved = "light";
    expect(native.groupedPage).toBe("platform:systemGroupedBackground");
    expect(native.groupedCell).toBe("platform:secondarySystemGroupedBackground");

    appearance.preference = "light";
    expect(native.groupedPage).toBe("token-muted");
    expect(native.groupedCell).toBe("token-card");
  });
});
