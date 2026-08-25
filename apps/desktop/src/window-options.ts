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
    backgroundColor: "#050506",
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

/** The first-run setup window is smaller and keeps the same frameless chrome. */
export function setupWindowOptions(platform: NodeJS.Platform) {
  return { width: 720, height: 700, minWidth: 480, minHeight: 560, ...windowChrome(platform) };
}
