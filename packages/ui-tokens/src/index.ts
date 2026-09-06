export const APPEARANCE_PREFERENCES = ["system", "light", "dark"] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];

export type ResolvedAppearance = "light" | "dark";

export const UI_APPEARANCE_STORAGE_KEY = "rakazo.uiAppearance";

/**
 * Semantic palette shared by web, Electron, and Expo. Names follow the shadcn
 * convention so the same slot means the same thing on every surface: a `border`
 * is always a border and never a fill.
 */
export type ColorTokens = {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarBorder: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  link: string;
  success: string;
  warning: string;
  overlay: string;
  scrollbar: string;
  scrollbarHover: string;
};

export const darkTokens = {
  background: "#0D0D0E",
  foreground: "#ECECEE",
  card: "#141416",
  cardForeground: "#ECECEE",
  popover: "#141416",
  popoverForeground: "#ECECEE",
  primary: "#F1F1EF",
  primaryForeground: "#1A1A1A",
  secondary: "#1A1A1D",
  secondaryForeground: "#ECECEE",
  muted: "#1A1A1D",
  mutedForeground: "#85858A",
  accent: "#202023",
  accentForeground: "#ECECEE",
  destructive: "#EF4444",
  destructiveForeground: "#FFFFFF",
  border: "#26262A",
  input: "#2A2A2E",
  ring: "#A6A6AD",
  sidebar: "#0B0B0C",
  sidebarForeground: "#ECECEE",
  sidebarBorder: "#171719",
  sidebarAccent: "#141416",
  sidebarAccentForeground: "#ECECEE",
  link: "#86B7FF",
  success: "#4ECB71",
  warning: "#E9C46A",
  overlay: "rgba(4, 4, 5, 0.62)",
  scrollbar: "#2A2A2E",
  scrollbarHover: "#414147",
} as const satisfies ColorTokens;

export const lightTokens = {
  background: "#FAFAF8",
  foreground: "#1A1A1A",
  card: "#FFFFFF",
  cardForeground: "#1A1A1A",
  popover: "#FFFFFF",
  popoverForeground: "#1A1A1A",
  primary: "#1A1A1A",
  primaryForeground: "#F1F1EF",
  secondary: "#F0F0ED",
  secondaryForeground: "#1A1A1A",
  muted: "#F0F0ED",
  mutedForeground: "#6C6C70",
  accent: "#EAEAE6",
  accentForeground: "#1A1A1A",
  destructive: "#DC2626",
  destructiveForeground: "#FFFFFF",
  border: "#F0F0ED",
  input: "#EAEAE6",
  ring: "#6C6C70",
  sidebar: "#ECECE9",
  sidebarForeground: "#1A1A1A",
  sidebarBorder: "#E8E8E4",
  sidebarAccent: "#FFFFFF",
  sidebarAccentForeground: "#1A1A1A",
  link: "#2563EB",
  success: "#228B3B",
  warning: "#B7791F",
  overlay: "rgba(20, 20, 22, 0.45)",
  scrollbar: "#C8C8C4",
  scrollbarHover: "#A8A8A4",
} as const satisfies ColorTokens;

/** Dark palette. Prefer `tokensForAppearance` when theme-aware. */
export const tokens = darkTokens;

export const RADIUS = "0.75rem";

export const botColors = [
  "#3EC5A8",
  "#F5A03C",
  "#6A6BF5",
  "#9B5CF6",
  "#3B82F6",
  "#F2622A",
  "#D9508A",
] as const;

export function isAppearancePreference(
  value: string | null | undefined,
): value is AppearancePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function normalizeAppearancePreference(
  raw: string | null | undefined,
): AppearancePreference {
  return isAppearancePreference(raw) ? raw : "system";
}

export type ResolveAppearancePreferenceOptions = {
  stored?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
};

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function resolveAppearancePreference(
  options: ResolveAppearancePreferenceOptions = {},
): AppearancePreference {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStoredAppearance(options.storage ?? getLocalStorage());
  return normalizeAppearancePreference(stored);
}

export function persistAppearancePreference(
  preference: AppearancePreference,
  storage: Pick<Storage, "setItem"> | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_APPEARANCE_STORAGE_KEY, preference);
  } catch {
    // Ignore quota / private-mode failures; in-memory preference still applies.
  }
}

export function resolveAppearance(
  preference: AppearancePreference,
  system: ResolvedAppearance = "dark",
): ResolvedAppearance {
  if (preference === "system") return system;
  return preference;
}

export function tokensForAppearance(appearance: ResolvedAppearance): ColorTokens {
  return appearance === "light" ? lightTokens : darkTokens;
}

function readStoredAppearance(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(UI_APPEARANCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** `cardForeground` -> `--card-foreground` */
export function cssVariableName(token: keyof ColorTokens): string {
  return `--${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function renderBlock(selector: string, colorScheme: ResolvedAppearance, palette: ColorTokens) {
  const lines = (Object.keys(palette) as (keyof ColorTokens)[]).map(
    (token) => `  ${cssVariableName(token)}: ${palette[token].toLowerCase()};`,
  );
  return `${selector} {\n  color-scheme: ${colorScheme};\n${lines.join("\n")}\n  --radius: ${RADIUS};\n}`;
}

/** The CSS in `tokens.css`. Generated from the TS palette so both stay in sync. */
export function renderTokensCss(): string {
  return `${[
    "/* Generated by `pnpm --filter @rakazo/ui-tokens generate`. Edit src/index.ts instead. */",
    renderBlock(':root,\n[data-theme="dark"]', "dark", darkTokens),
    renderBlock('[data-theme="light"]', "light", lightTokens),
  ].join("\n\n")}\n`;
}
