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
    backgroundColor: "#0D0D0E",
    show: true,
    autoHideMenuBar: true,
    frame: mac,
    titleBarStyle: mac ? ("hiddenInset" as const) : undefined,
    trafficLightPosition: mac ? { x: 16, y: 16 } : undefined,
  };
}

export function browserWindowOptions(platform: NodeJS.Platform) {
  return { width: 1440, height: 900, ...windowChrome(platform) };
}

/**
 * Unpackaged (dev) launches set the dock/taskbar icon by hand. macOS draws the file as-is,
 * so it needs the squircle-with-margins asset; packaged builds already use icon.icns.
 */
export function developmentIconFile(platform: NodeJS.Platform) {
  return platform === "darwin" ? "icon-macos.png" : "icon.png";
}

/** The first-run setup window is smaller and keeps the same frameless chrome. */
export function setupWindowOptions(platform: NodeJS.Platform) {
  return { width: 720, height: 700, minWidth: 480, minHeight: 560, ...windowChrome(platform) };
}
