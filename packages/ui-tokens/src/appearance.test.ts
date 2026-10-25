import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ColorTokens } from "./index.js";
import {
  botColors,
  cssVariableName,
  darkTokens,
  lightTokens,
  normalizeAppearancePreference,
  persistAppearancePreference,
  renderTokensCss,
  resolveAppearance,
  resolveAppearancePreference,
  tokensForAppearance,
  UI_APPEARANCE_STORAGE_KEY,
  webDarkOverrides,
  webDarkTokens,
  webLightOverrides,
  webLightTokens,
  webTokensForAppearance,
} from "./index.js";

describe("appearance preference", () => {
  it("defaults unknown values to system", () => {
    expect(normalizeAppearancePreference(null)).toBe("system");
    expect(normalizeAppearancePreference("nope")).toBe("system");
    expect(normalizeAppearancePreference("light")).toBe("light");
  });

  it("resolves system from the platform scheme", () => {
    expect(resolveAppearance("system", "light")).toBe("light");
    expect(resolveAppearance("system", "dark")).toBe("dark");
    expect(resolveAppearance("dark", "light")).toBe("dark");
  });

  it("reads and writes storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    expect(resolveAppearancePreference({ storage })).toBe("system");
    persistAppearancePreference("light", storage);
    expect(store.get(UI_APPEARANCE_STORAGE_KEY)).toBe("light");
    expect(resolveAppearancePreference({ storage })).toBe("light");
  });

  it("returns distinct light and dark token sets", () => {
    expect(tokensForAppearance("dark")).toBe(darkTokens);
    expect(tokensForAppearance("light")).toBe(lightTokens);
    for (const key of Object.keys(darkTokens) as (keyof ColorTokens)[]) {
      if (
        key === "chatUserForeground" ||
        key === "destructiveForeground" ||
        key === "destructiveFill" ||
        key === "faviconPlate" ||
        key === "unread" ||
        key === "workingDot"
      )
        continue;
      expect(darkTokens[key], key).not.toBe(lightTokens[key]);
    }
    // Link icons keep a white plate in both themes; the light user bubble is near-black.
    expect(lightTokens.faviconPlate).toBe("#FFFFFF");
    expect(darkTokens.faviconPlate).toBe("#FFFFFF");
  });

  it("keeps the working dot the same green in both themes", () => {
    expect(lightTokens.workingDot).toBe("#3FA266");
    expect(darkTokens.workingDot).toBe(lightTokens.workingDot);
  });

  it("keeps working-state blue in its own semantic token across themes", () => {
    expect(darkTokens.statusWorking).toBeTruthy();
    expect(lightTokens.statusWorking).toBeTruthy();
    expect(darkTokens.statusWorking).toBe(darkTokens.link);
    expect(lightTokens.statusWorking).toBe(lightTokens.link);
    expect(darkTokens.statusWorking).not.toBe(darkTokens.primary);
    expect(lightTokens.statusWorking).not.toBe(lightTokens.primary);
  });

  it("keeps user message surfaces muted, not cream invert", () => {
    const dark = tokensForAppearance("dark");
    const light = tokensForAppearance("light");
    expect(dark.secondary).not.toBe(dark.primary);
    expect(light.secondary).not.toBe(light.primary);
    expect(dark.secondaryForeground).not.toBe(dark.primaryForeground);
  });

  it("separates user bubbles from bot bubbles and the sidebar from the app", () => {
    const dark = tokensForAppearance("dark");
    const light = tokensForAppearance("light");
    expect(dark.chatUser).not.toBe(dark.muted);
    expect(light.chatUser).not.toBe(light.muted);
    expect(dark.sidebar).not.toBe(dark.background);
    expect(light.sidebar).not.toBe(light.background);
  });

  it("tolerates a throwing localStorage getter", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(resolveAppearancePreference()).toBe("system");
      persistAppearancePreference("light");
      expect(resolveAppearancePreference()).toBe("system");
    } finally {
      if (desc) Object.defineProperty(globalThis, "localStorage", desc);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});

// Composite translucent foregrounds before measuring WCAG 2.x contrast.
function contrastRatio(a: string, b: string): number {
  const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const alpha = a.length === 9 ? Number.parseInt(a.slice(7, 9), 16) / 255 : 1;
  const backdrop = rgb(b);
  const foreground = rgb(a).map((c, i) => c * alpha + backdrop[i]! * (1 - alpha));
  const luminance = (channels: number[]) =>
    channels.reduce((sum, value, i) => {
      const c = value / 255;
      return (
        sum +
        [0.2126, 0.7152, 0.0722][i]! * (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      );
    }, 0);
  const la = luminance(foreground);
  const lb = luminance(backdrop);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("light palette readability", () => {
  it.each(["background", "card", "muted"] as const)(
    "keeps faint text readable and lighter than secondary text on %s",
    (surface) => {
      const faint = contrastRatio(lightTokens.faintForeground, lightTokens[surface]);
      const secondary = contrastRatio(lightTokens.mutedForeground, lightTokens[surface]);
      expect(faint).toBeGreaterThanOrEqual(3);
      expect(secondary - faint).toBeGreaterThanOrEqual(1);
    },
  );

  it("separates grouped cells at least as much as the iOS grouped palette", () => {
    expect(contrastRatio(lightTokens.card, lightTokens.background)).toBeGreaterThanOrEqual(
      contrastRatio("#FFFFFF", "#F2F2F7"),
    );
  });

  it("keeps enabled password actions readable", () => {
    expect(
      contrastRatio(lightTokens.primaryForeground, lightTokens.primary),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("dark palette readability", () => {
  // The destructive fill follows the system palette; ordinary body text meets AA.
  it.each(["background", "card", "muted"] as const)(
    "keeps faint text readable on %s",
    (surface) => {
      expect(contrastRatio(darkTokens.faintForeground, darkTokens[surface])).toBeGreaterThanOrEqual(
        3,
      );
    },
  );

  it.each(botColors)("keeps bot identity %s readable on dark messages", (color) => {
    for (const surface of [darkTokens.background, darkTokens.muted]) {
      expect(contrastRatio(color, surface)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe.each([
  ["dark", darkTokens],
  ["light", lightTokens],
] as const)("%s palette contrast", (_name, palette: ColorTokens) => {
  // Opaque text tokens on the surfaces they are drawn on. Secondary and faint text are
  // translucent system label colours and white on the solid red fill is 3.9:1, so the
  // palette matches the iOS design there instead of 4.5:1; they are not listed.
  const pairs: [keyof ColorTokens, keyof ColorTokens][] = [
    ["foreground", "background"],
    ["foreground", "dialog"],
    ["cardForeground", "card"],
    ["popoverForeground", "popover"],
    ["foreground", "muted"],
    ["chatUserForeground", "chatUser"],
    ["chatUserForeground", "unread"],
    ["primaryForeground", "primary"],
    ["sidebarForeground", "sidebar"],
    ["sidebarAccentForeground", "sidebarAccent"],
    ["link", "background"],
    ["link", "card"],
    ["destructive", "background"],
    ["destructive", "card"],
    ["success", "background"],
    ["success", "card"],
  ];

  it.each(pairs)("%s on %s meets WCAG AA (4.5:1)", (text, surface) => {
    expect(contrastRatio(palette[text], palette[surface])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("tokens.css", () => {
  it("derives kebab-case variable names", () => {
    expect(cssVariableName("background")).toBe("--background");
    expect(cssVariableName("mutedForeground")).toBe("--muted-foreground");
    expect(cssVariableName("sidebarAccentForeground")).toBe("--sidebar-accent-foreground");
  });

  it("is generated from the TS palette", () => {
    const onDisk = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");
    expect(onDisk).toBe(renderTokensCss());
  });

  it("scopes light and dark under data-theme", () => {
    const css = renderTokensCss();
    expect(css).toContain('[data-theme="dark"] {\n  color-scheme: dark;');
    expect(css).toContain('[data-theme="light"] {\n  color-scheme: light;');
    expect(css).toContain(`--background: ${webLightTokens.background.toLowerCase()};`);
    expect(css).toContain(`--background: ${webDarkTokens.background.toLowerCase()};`);
  });
});

describe("web palette", () => {
  // Mobile follows the iOS system palette; web overrides only some tokens on top of it.
  const mobileDark = {
    background: "#141414",
    dialog: "#1E1E1E",
    foreground: "#FFFFFF",
    card: "#202020",
    cardForeground: "#FFFFFF",
    popover: "#202020",
    popoverForeground: "#FFFFFF",
    glassFill: "#2C2C2E",
    glassStroke: "#FCFCFC26",
    primary: "#FFFFFF",
    primaryForeground: "#000000",
    secondary: "#7676803D",
    secondaryForeground: "#FFFFFF",
    chatUser: "#5C5C5C",
    chatUserForeground: "#FFFFFF",
    muted: "#202020",
    mutedForeground: "#EBEBF599",
    faintForeground: "#EBEBF573",
    accent: "#78788052",
    accentForeground: "#FFFFFF",
    destructive: "#FF9592",
    destructiveFill: "#E5484D",
    destructiveForeground: "#FFFFFF",
    border: "#FCFCFC14",
    input: "#54545899",
    ring: "#3B82F6",
    sidebar: "#1E1E1E",
    sidebarForeground: "#FFFFFF",
    sidebarBorder: "#FCFCFC14",
    sidebarAccent: "#2B2B2E",
    sidebarAccentForeground: "#FFFFFF",
    link: "#459FFE",
    faviconPlate: "#FFFFFF",
    success: "#3FA266",
    warning: "#DB941E",
    statusWorking: "#459FFE",
    unread: "#006CEB",
    workingDot: "#3FA266",
    overlay: "rgba(0, 0, 0, 0.28)",
    scrollbar: "#1E2026",
    scrollbarHover: "#2E313A",
  };
  const mobileLight = {
    background: "#FCFCFC",
    dialog: "#FFFFFF",
    foreground: "#000000",
    card: "#EFEFEF",
    cardForeground: "#000000",
    popover: "#FFFFFF",
    popoverForeground: "#000000",
    glassFill: "#FFFFFF",
    glassStroke: "#14141416",
    primary: "#000000",
    primaryForeground: "#FFFFFF",
    secondary: "#7676801F",
    secondaryForeground: "#000000",
    chatUser: "#0B0B0B",
    chatUserForeground: "#FFFFFF",
    muted: "#F2F2F1",
    mutedForeground: "#3C3C43B3",
    faintForeground: "#3C3C4394",
    accent: "#78788029",
    accentForeground: "#000000",
    destructive: "#CE2C31",
    destructiveFill: "#E5484D",
    destructiveForeground: "#FFFFFF",
    border: "#14141414",
    input: "#3C3C434A",
    ring: "#6C6C70",
    sidebar: "#F7F7F7",
    sidebarForeground: "#000000",
    sidebarBorder: "#14141414",
    sidebarAccent: "#FFFFFF",
    sidebarAccentForeground: "#000000",
    link: "#0C64C1",
    faviconPlate: "#FFFFFF",
    success: "#007041",
    warning: "#885A07",
    statusWorking: "#0C64C1",
    unread: "#006CEB",
    workingDot: "#3FA266",
    overlay: "rgba(0, 0, 0, 0.19)",
    scrollbar: "#C8C8C4",
    scrollbarHover: "#A8A8A4",
  };

  it("leaves the mobile palettes unchanged", () => {
    expect(darkTokens).toEqual(mobileDark);
    expect(lightTokens).toEqual(mobileLight);
    expect(tokensForAppearance("dark")).toBe(darkTokens);
    expect(tokensForAppearance("light")).toBe(lightTokens);
  });

  it.each([
    ["dark", darkTokens, webDarkOverrides, webDarkTokens],
    ["light", lightTokens, webLightOverrides, webLightTokens],
  ] as const)(
    "differs from the %s mobile palette only in its overrides",
    (theme, mobile, overrides, web) => {
      expect(webTokensForAppearance(theme)).toBe(web);
      for (const key of Object.keys(mobile) as (keyof ColorTokens)[]) {
        expect(web[key], key).toBe(
          key in overrides ? overrides[key as keyof typeof overrides] : mobile[key],
        );
      }
    },
  );

  it("renders tokens.css from the web palettes", () => {
    const css = renderTokensCss();
    expect(css).toContain(`--muted-foreground: ${webDarkTokens.mutedForeground.toLowerCase()};`);
    expect(css).toContain(`--muted-foreground: ${webLightTokens.mutedForeground.toLowerCase()};`);
    expect(css).not.toContain(`--muted-foreground: ${darkTokens.mutedForeground.toLowerCase()};`);
  });

  it.each([
    ["dark", webDarkTokens, { primaryHover: "#DBDBDB", primaryDisabled: "#F5F5F521" }],
    ["light", webLightTokens, { primaryHover: "#363636", primaryDisabled: "#1C1C1C26" }],
  ] as const)("gives the %s primary fill web-only hover and disabled states", (_, web, states) => {
    expect(web).toMatchObject(states);
    const css = renderTokensCss();
    expect(css).toContain(`--primary-hover: ${states.primaryHover.toLowerCase()};`);
    expect(css).toContain(`--primary-disabled: ${states.primaryDisabled.toLowerCase()};`);
    expect("primaryHover" in darkTokens || "primaryHover" in lightTokens).toBe(false);
  });
});

describe.each([
  ["dark", webDarkTokens],
  ["light", webLightTokens],
] as const)("web %s palette contrast", (theme, palette: ColorTokens) => {
  // Opaque text on the surfaces it is drawn on. The web palette copies the target design
  // exactly, so in light mode success and warning text on cards and white on the red fill
  // sit below 4.5:1 and are not listed.
  const pairs: [keyof ColorTokens, keyof ColorTokens][] = [
    ["foreground", "background"],
    ["foreground", "dialog"],
    ["cardForeground", "card"],
    ["popoverForeground", "popover"],
    ["foreground", "muted"],
    ["mutedForeground", "background"],
    ["mutedForeground", "card"],
    ["chatUserForeground", "chatUser"],
    ["primaryForeground", "primary"],
    ["sidebarForeground", "sidebar"],
    ["link", "background"],
    ["link", "card"],
    ["destructive", "background"],
    ["destructive", "card"],
    ["success", "background"],
    ["warning", "background"],
    ...(theme === "dark"
      ? ([
          ["success", "card"],
          ["warning", "card"],
          ["destructiveForeground", "destructiveFill"],
        ] as [keyof ColorTokens, keyof ColorTokens][])
      : []),
  ];

  it.each(pairs)("%s on %s meets WCAG AA (4.5:1)", (text, surface) => {
    expect(contrastRatio(palette[text], palette[surface])).toBeGreaterThanOrEqual(4.5);
  });
});
