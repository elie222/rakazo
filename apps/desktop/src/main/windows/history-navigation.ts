/**
 * Which history entry a back or forward gesture lands on: a macOS trackpad swipe ("left" is back,
 * as in a browser) or a Windows and Linux app command from a mouse's side buttons or a keyboard's
 * browser keys. Null when the gesture is something else, or when the entry is not one of the app's
 * own pages, so back stops at the page the window opened on.
 */
export function historyTarget(
  gesture: string,
  history: { urls: readonly string[]; activeIndex: number },
  appOrigin: string | null,
): number | null {
  const step = HISTORY_STEPS[gesture];
  if (step === undefined || appOrigin === null) return null;
  const index = history.activeIndex + step;
  const url = history.urls[index];
  return url !== undefined && originOf(url) === appOrigin ? index : null;
}

const HISTORY_STEPS: Partial<Record<string, -1 | 1>> = {
  left: -1,
  right: 1,
  "browser-backward": -1,
  "browser-forward": 1,
};

function originOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
