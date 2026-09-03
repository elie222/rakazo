import {
  type AppearancePreference,
  persistAppearancePreference,
  type ResolvedAppearance,
  resolveAppearance,
  resolveAppearancePreference,
  tokensForAppearance,
} from "@rakazo/ui-tokens";

export type { AppearancePreference, ResolvedAppearance };

const THEME_COLOR_META = 'meta[name="theme-color"]';

export function readSystemAppearance(
  media: Pick<MediaQueryList, "matches"> | null = typeof window !== "undefined"
    ? window.matchMedia("(prefers-color-scheme: light)")
    : null,
): ResolvedAppearance {
  return media?.matches ? "light" : "dark";
}

export function applyResolvedAppearance(
  appearance: ResolvedAppearance,
  root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null,
): void {
  if (!root) return;
  root.dataset.theme = appearance;
  root.style.colorScheme = appearance;
  if (typeof document === "undefined") return;
  const meta = document.querySelector(THEME_COLOR_META);
  if (meta) {
    meta.setAttribute("content", tokensForAppearance(appearance).background);
  }
}

export function applyUiAppearance(
  preference: AppearancePreference = resolveAppearancePreference(),
  system: ResolvedAppearance = readSystemAppearance(),
): ResolvedAppearance {
  const resolved = resolveAppearance(preference, system);
  applyResolvedAppearance(resolved);
  return resolved;
}

export function setUiAppearance(preference: AppearancePreference): ResolvedAppearance {
  persistAppearancePreference(preference);
  return applyUiAppearance(preference);
}

export function getUiAppearancePreference(): AppearancePreference {
  return resolveAppearancePreference();
}

/** Keep `data-theme` in sync when the OS scheme changes and preference is System. */
export function watchSystemAppearance(
  onChange: (system: ResolvedAppearance) => void = () => {
    if (resolveAppearancePreference() === "system") applyUiAppearance("system");
  },
): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const handler = () => onChange(media.matches ? "light" : "dark");
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}
