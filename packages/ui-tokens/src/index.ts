export const APPEARANCE_PREFERENCES = ["system", "light", "dark"] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];

export type ResolvedAppearance = "light" | "dark";

export const UI_APPEARANCE_STORAGE_KEY = "rakazo.uiAppearance";

export type ColorTokens = {
  page: string;
  sidebar: string;
  main: string;
  panel: string;
  inset: string;
  hairline: string;
  hairlineStrong: string;
  border: string;
  surface: string;
  surface2: string;
  elevated: string;
  ink: string;
  inkStrong: string;
  body: string;
  soft: string;
  muted: string;
  muted2: string;
  faint: string;
  cream: string;
  creamInk: string;
  accent: string;
  danger: string;
  dangerStrong: string;
  dangerSoft: string;
  success: string;
  successSoft: string;
  scroll: string;
  scrollHover: string;
  overlay: string;
};

export const darkTokens = {
  page: "#050506",
  sidebar: "#0B0B0C",
  main: "#0D0D0E",
  panel: "#0A0A0B",
  inset: "#101012",
  hairline: "#171719",
  hairlineStrong: "#202023",
  border: "#26262A",
  surface: "#141416",
  surface2: "#1A1A1D",
  elevated: "#1B1B1E",
  ink: "#ECECEE",
  inkStrong: "#F1F1F2",
  body: "#DFDFE2",
  soft: "#C9C9CE",
  muted: "#85858A",
  muted2: "#6C6C70",
  faint: "#7A7A80",
  cream: "#F1F1EF",
  creamInk: "#1A1A1A",
  accent: "#3EC5A8",
  danger: "#EF4444",
  dangerStrong: "#DC2626",
  dangerSoft: "#FCA5A5",
  success: "#30A24B",
  successSoft: "#4ECB71",
  scroll: "#2A2A2E",
  scrollHover: "#414147",
  overlay: "rgba(4, 4, 5, 0.62)",
} as const satisfies ColorTokens;

export const lightTokens = {
  page: "#F4F4F2",
  sidebar: "#ECECE9",
  main: "#FAFAF8",
  panel: "#F7F7F5",
  inset: "#FFFFFF",
  hairline: "#E4E4E0",
  hairlineStrong: "#D6D6D2",
  border: "#D0D0CC",
  surface: "#FFFFFF",
  surface2: "#F0F0ED",
  elevated: "#EAEAE6",
  ink: "#1A1A1A",
  inkStrong: "#111111",
  body: "#2E2E32",
  soft: "#4A4A50",
  muted: "#6C6C70",
  muted2: "#85858A",
  faint: "#7A7A80",
  cream: "#1A1A1A",
  creamInk: "#F1F1EF",
  accent: "#2A9E86",
  danger: "#DC2626",
  dangerStrong: "#B91C1C",
  dangerSoft: "#F87171",
  success: "#228B3B",
  successSoft: "#30A24B",
  scroll: "#C8C8C4",
  scrollHover: "#A8A8A4",
  overlay: "rgba(20, 20, 22, 0.45)",
} as const satisfies ColorTokens;

/** Dark palette. Prefer `darkTokens` / `tokensForAppearance` when theme-aware. */
export const tokens = darkTokens;

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
