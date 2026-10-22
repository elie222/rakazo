import { darkTokens, lightTokens } from "@rakazo/ui-tokens";
import { beforeEach, describe, expect, it, vi } from "vitest";

const appearance = vi.hoisted(() => ({
  realTokens: false,
  preference: "system" as "system" | "light" | "dark",
  resolved: "dark" as "dark" | "light",
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  PlatformColor: (name: string) => `platform:${name}`,
}));

vi.mock("./appearance", () => ({
  getCachedAppearancePreference: () => appearance.preference,
  mobileTokens: () =>
    appearance.realTokens
      ? appearance.resolved === "dark"
        ? darkTokens
        : lightTokens
      : {
          background: "token-background",
          border: "token-border",
          card: "token-card",
          faintForeground: "token-faint",
          mutedForeground: "token-secondary",
          muted: "token-muted",
        },
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

  it("uses the token page and card in light too, in System and forced Light", () => {
    appearance.resolved = "light";
    expect(native.groupedPage).toBe("token-background");
    expect(native.groupedCell).toBe("token-card");

    appearance.preference = "light";
    expect(native.groupedPage).toBe("token-background");
    expect(native.groupedCell).toBe("token-card");
  });
});

describe("text, fills and separators", () => {
  beforeEach(() => {
    appearance.preference = "system";
    appearance.resolved = "light";
  });

  it("divides rows with the palette divider in every mode", () => {
    expect(native.separator).toBe("token-border");
    appearance.preference = "dark";
    expect(native.separator).toBe("token-border");
  });

  it("falls back to faint text for tertiary labels and the muted fill for quiet chips", () => {
    expect(native.secondaryLabel).toBe("token-secondary");
    expect(native.tertiaryLabel).toBe("token-faint");
    expect(native.quietFill).toBe("platform:quaternarySystemFill");

    appearance.preference = "light";
    expect(native.secondaryLabel).toBe("token-secondary");
    expect(native.tertiaryLabel).toBe("token-faint");
    expect(native.quietFill).toBe("token-muted");
  });
});

it.each(["system", "dark"] as const)("uses readable faint text in %s dark mode", (preference) => {
  appearance.preference = preference;
  appearance.resolved = "dark";
  expect(native.tertiaryLabel).toBe("token-faint");
});

it.each([
  ["system", "dark"],
  ["dark", "dark"],
  ["system", "light"],
  ["light", "light"],
] as const)(
  "keeps tertiary labels above 3:1 on grouped surfaces in %s / %s",
  (preference, resolved) => {
    appearance.preference = preference;
    appearance.resolved = resolved;
    appearance.realTokens = true;
    try {
      for (const surface of [native.groupedPage, native.groupedCell]) {
        const bg = String(surface);
        const fg = String(native.tertiaryLabel);
        const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
        const backdrop = rgb(bg);
        const alpha = Number.parseInt(fg.slice(7, 9), 16) / 255;
        const composite = rgb(fg).map((value, i) => value * alpha + backdrop[i]! * (1 - alpha));
        const luminance = (channels: number[]) =>
          channels.reduce((sum, value, i) => {
            const c = value / 255;
            return (
              sum +
              [0.2126, 0.7152, 0.0722][i]! *
                (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
            );
          }, 0);
        const foreground = luminance(composite);
        const background = luminance(backdrop);
        const ratio =
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
        expect(ratio).toBeGreaterThanOrEqual(3);
      }
    } finally {
      appearance.realTokens = false;
    }
  },
);
