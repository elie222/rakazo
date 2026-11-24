import os from "node:os";

export const DEFAULT_WARM_WINDOW_TTL_MS = 15 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function warmWindowTtlMs(value: string | undefined) {
  if (value === undefined || value.trim() === "") return DEFAULT_WARM_WINDOW_TTL_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_TIMER_DELAY_MS
    ? parsed
    : DEFAULT_WARM_WINDOW_TTL_MS;
}

/**
 * Centers the traffic lights on the web shell's top bar (y 26) and its 92px icon rail (x 46).
 * macOS 26 (Darwin 25) draws them 60px wide; earlier releases 52px.
 */
function trafficLightPosition(darwinRelease: string) {
  return { x: Number.parseInt(darwinRelease, 10) >= 25 ? 16 : 20, y: 19 };
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

/**
 * The app window opens in the background its page last painted, so an appearance picked in
 * settings does not flash the system's. A system that has switched appearance since then
 * (automatic light and dark, say) means the page most likely follows it, so the window does too.
 */
export function appWindowBackground(saved: SavedBackground | null, systemUsesDarkColors: boolean) {
  return saved !== null && saved.systemUsesDarkColors === systemUsesDarkColors
    ? saved.color
    : systemWindowBackground(systemUsesDarkColors);
}

function windowChrome(platform: NodeJS.Platform, release: string) {
  const mac = platform === "darwin";
  return {
    show: true,
    autoHideMenuBar: true,
    frame: mac || platform === "win32",
    titleBarStyle: mac ? ("hiddenInset" as const) : undefined,
    trafficLightPosition: mac ? trafficLightPosition(release) : undefined,
  };
}

type WorkArea = { width: number; height: number };

// Smallest the app window can be dragged: the web shell's phone layout. 390 is the
// width the e2e suite runs that layout at (and the side panel's 384px max fits inside it);
// 480 keeps the header, composer and a few messages on screen.
export const APP_WINDOW_MIN_WIDTH = 390;
export const APP_WINDOW_MIN_HEIGHT = 480;

/** Opens as a window inside the screen's work area rather than filling it. */
export function browserWindowOptions(
  platform: NodeJS.Platform,
  workArea: WorkArea,
  release = os.release(),
) {
  return {
    width: Math.min(1280, Math.round(workArea.width * 0.8)),
    height: Math.min(840, Math.round(workArea.height * 0.85)),
    minWidth: Math.min(APP_WINDOW_MIN_WIDTH, workArea.width),
    minHeight: Math.min(APP_WINDOW_MIN_HEIGHT, workArea.height),
    ...windowChrome(platform, release),
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
export function setupWindowOptions(
  platform: NodeJS.Platform,
  workArea: WorkArea,
  release = os.release(),
) {
  const width = Math.min(720, workArea.width);
  const height = Math.min(700, workArea.height);
  return {
    width,
    height,
    minWidth: Math.min(480, width),
    minHeight: Math.min(560, height),
    backgroundColor: DARK_BACKGROUND,
    ...windowChrome(platform, release),
  };
}
