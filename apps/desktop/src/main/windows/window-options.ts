export const DEFAULT_WARM_WINDOW_TTL_MS = 15 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function warmWindowTtlMs(value: string | undefined) {
  if (value === undefined || value.trim() === "") return DEFAULT_WARM_WINDOW_TTL_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_TIMER_DELAY_MS
    ? parsed
    : DEFAULT_WARM_WINDOW_TTL_MS;
}

// Keep in sync with the web background tokens from @rakazo/ui-tokens (asserted in tests).
// Do not import that package here: desktop packs compiled JS only and ui-tokens is a
// TypeScript source / devDependency.
const DARK_BACKGROUND = "#0A0A0A";
const LIGHT_BACKGROUND = "#FFFFFF";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** What a window shows before its page paints, when nothing better is known: the system appearance. */
export function systemWindowBackground(systemUsesDarkColors: boolean) {
  return systemUsesDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}

/** A page's reported theme color, when it is one a window can use as its background. */
export function paintedBackground(color: string | null | undefined) {
  return color && HEX_COLOR.test(color) ? color : null;
}

/** The background the app's page last painted, and the system appearance at the time. */
export type SavedBackground = { color: string; systemUsesDarkColors: boolean };

/** A saved background read back from disk, or null when it is missing or not one. */
export function parseSavedBackground(text: string | null): SavedBackground | null {
  try {
    const value: unknown = JSON.parse(text ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { color, systemUsesDarkColors } = value as Record<string, unknown>;
    const background = paintedBackground(typeof color === "string" ? color : null);
    return background !== null && typeof systemUsesDarkColors === "boolean"
      ? { color: background, systemUsesDarkColors }
      : null;
  } catch {
    return null;
  }
}

function isDark(color: string) {
  const [red, green, blue] = [1, 3, 5].map((start) =>
    Number.parseInt(color.slice(start, start + 2), 16),
  ) as [number, number, number];
  return (red * 299 + green * 587 + blue * 114) / 1000 < 128;
}

/**
 * The app window opens in the background its page last painted, so an appearance picked in
 * settings does not flash the system's. A page that matched the system then most likely follows
 * it, so once the system has switched appearance (automatic light and dark, say), so does the
 * window. One that did not match was set in settings and stays.
 */
export function appWindowBackground(saved: SavedBackground | null, systemUsesDarkColors: boolean) {
  if (saved === null) return systemWindowBackground(systemUsesDarkColors);
  const followedSystem = isDark(saved.color) === saved.systemUsesDarkColors;
  return followedSystem && saved.systemUsesDarkColors !== systemUsesDarkColors
    ? systemWindowBackground(systemUsesDarkColors)
    : saved.color;
}

function windowChrome(platform: NodeJS.Platform) {
  const mac = platform === "darwin";
  return {
    show: true,
    autoHideMenuBar: true,
    frame: mac || platform === "win32",
    titleBarStyle: mac ? ("hiddenInset" as const) : undefined,
    trafficLightPosition: mac ? { x: 16, y: 19 } : undefined,
  };
}

type WorkArea = { width: number; height: number };

// Smallest the app window can be dragged: the web shell's phone layout. 390 is the
// width the e2e suite runs that layout at (and the side panel's 384px max fits inside it);
// 480 keeps the header, composer and a few messages on screen.
export const APP_WINDOW_MIN_WIDTH = 390;
export const APP_WINDOW_MIN_HEIGHT = 480;

/** Opens as a window inside the screen's work area rather than filling it. */
export function browserWindowOptions(platform: NodeJS.Platform, workArea: WorkArea) {
  return {
    width: Math.min(1280, Math.round(workArea.width * 0.8)),
    height: Math.min(840, Math.round(workArea.height * 0.85)),
    minWidth: Math.min(APP_WINDOW_MIN_WIDTH, workArea.width),
    minHeight: Math.min(APP_WINDOW_MIN_HEIGHT, workArea.height),
    ...windowChrome(platform),
  };
}

/**
 * Unpackaged (dev) launches set the dock/taskbar icon by hand. macOS draws the file as-is,
 * so it needs the squircle-with-margins asset; packaged builds already use icon.icns.
 */
export function developmentIconFile(platform: NodeJS.Platform) {
  return platform === "darwin" ? "icon-macos.png" : "icon.png";
}

/** The first-run setup window is smaller and keeps the same platform chrome. Its page is always dark. */
export function setupWindowOptions(platform: NodeJS.Platform, workArea: WorkArea) {
  const width = Math.min(720, workArea.width);
  const height = Math.min(700, workArea.height);
  return {
    width,
    height,
    minWidth: Math.min(480, width),
    minHeight: Math.min(560, height),
    backgroundColor: DARK_BACKGROUND,
    ...windowChrome(platform),
  };
}

type Rectangle = { x: number; y: number; width: number; height: number };
/** The app window's last normal (unmaximized) rectangle and whether it was maximized or full screen. */
export type SavedWindowBounds = Rectangle & { maximized: boolean; fullScreen: boolean };

/** Reads what `JSON.stringify(SavedWindowBounds)` wrote; anything else means no saved bounds. */
export function parseSavedWindowBounds(text: string): SavedWindowBounds | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { x, y, width, height, maximized, fullScreen } = value as Record<string, unknown>;
  const integer = (n: unknown): n is number => Number.isSafeInteger(n);
  if (!integer(x) || !integer(y) || !integer(width) || !integer(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height, maximized: maximized === true, fullScreen: fullScreen === true };
}

function overlapArea(a: Rectangle, b: Rectangle) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * The saved bounds when at least half the window still lands on a connected display's work area
 * (displays do not overlap, so the shares add up); otherwise null, so the window opens at the default.
 */
export function restorableWindowBounds(
  saved: SavedWindowBounds | null,
  workAreas: Rectangle[],
): SavedWindowBounds | null {
  if (saved === null) return null;
  const visible = workAreas.reduce((sum, area) => sum + overlapArea(saved, area), 0);
  return visible * 2 >= saved.width * saved.height ? saved : null;
}
