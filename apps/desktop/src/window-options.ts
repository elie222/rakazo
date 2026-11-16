export const DEFAULT_WARM_WINDOW_TTL_MS = 15 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function warmWindowTtlMs(value: string | undefined) {
  if (value === undefined || value.trim() === "") return DEFAULT_WARM_WINDOW_TTL_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_TIMER_DELAY_MS
    ? parsed
    : DEFAULT_WARM_WINDOW_TTL_MS;
}

function windowChrome(platform: NodeJS.Platform) {
  const mac = platform === "darwin";
  return {
    // Keep in sync with webDarkTokens.background from @rakazo/ui-tokens (asserted in tests).
    // Do not import that package here: desktop packs compiled JS only and ui-tokens is a
    // TypeScript source / devDependency.
    backgroundColor: "#0A0A0A",
    show: true,
    autoHideMenuBar: true,
    frame: mac || platform === "win32",
    titleBarStyle: mac ? ("hiddenInset" as const) : undefined,
    trafficLightPosition: mac ? { x: 16, y: 16 } : undefined,
  };
}

type WorkArea = { width: number; height: number };

/** Opens as a window inside the screen's work area rather than filling it. */
export function browserWindowOptions(platform: NodeJS.Platform, workArea: WorkArea) {
  return {
    width: Math.min(1280, Math.round(workArea.width * 0.8)),
    height: Math.min(840, Math.round(workArea.height * 0.85)),
    ...windowChrome(platform),
  };
}

type Bounds = { x: number; y: number; width: number; height: number };
/** The app window as it was last closed: its normal (unmaximized) bounds. */
export type SavedWindow = Bounds & { maximized: boolean };

// Smaller saved sizes are treated as damaged: the window would be too small to use.
const MIN_SAVED_WIDTH = 400;
const MIN_SAVED_HEIGHT = 300;

export function parseSavedWindow(raw: string): SavedWindow | null {
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof SavedWindow, unknown>> | null;
    const { x, y, width, height, maximized } = value ?? {};
    if (![x, y, width, height].every(Number.isFinite)) return null;
    if ((width as number) < MIN_SAVED_WIDTH || (height as number) < MIN_SAVED_HEIGHT) return null;
    return {
      x: Math.round(x as number),
      y: Math.round(y as number),
      width: Math.round(width as number),
      height: Math.round(height as number),
      maximized: maximized === true,
    };
  } catch {
    return null;
  }
}

/**
 * The saved window, moved and shrunk to fit fully inside the display that holds its center; null
 * when no connected display does, so the window opens at its default.
 */
export function restorableWindow(
  saved: SavedWindow | null,
  workAreas: readonly Bounds[],
): SavedWindow | null {
  if (saved === null) return null;
  const centerX = saved.x + saved.width / 2;
  const centerY = saved.y + saved.height / 2;
  const area = workAreas.find(
    (a) => centerX >= a.x && centerX < a.x + a.width && centerY >= a.y && centerY < a.y + a.height,
  );
  if (!area) return null;
  const width = Math.min(saved.width, area.width);
  const height = Math.min(saved.height, area.height);
  return {
    x: Math.min(Math.max(saved.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(saved.y, area.y), area.y + area.height - height),
    width,
    height,
    maximized: saved.maximized,
  };
}

/**
 * Unpackaged (dev) launches set the dock/taskbar icon by hand. macOS draws the file as-is,
 * so it needs the squircle-with-margins asset; packaged builds already use icon.icns.
 */
export function developmentIconFile(platform: NodeJS.Platform) {
  return platform === "darwin" ? "icon-macos.png" : "icon.png";
}

/** The first-run setup window is smaller and keeps the same platform chrome. */
export function setupWindowOptions(platform: NodeJS.Platform, workArea: WorkArea) {
  const width = Math.min(720, workArea.width);
  const height = Math.min(700, workArea.height);
  return {
    width,
    height,
    minWidth: Math.min(480, width),
    minHeight: Math.min(560, height),
    ...windowChrome(platform),
  };
}
