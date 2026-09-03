const PRELOAD_RECOVERY_KEY = "rk:preload-recovery";
const PRELOAD_RECOVERY_COOLDOWN_MS = 30_000;

type PreloadRecoveryWindow = Pick<
  Window,
  | "addEventListener"
  | "clearTimeout"
  | "location"
  | "removeEventListener"
  | "sessionStorage"
  | "setTimeout"
>;

/**
 * Vite emits this event when a lazy chunk from an older deployment no longer
 * exists. Reload once so the browser receives the current asset manifest.
 */
export function installPreloadRecovery(target: PreloadRecoveryWindow = window): () => void {
  const clearRecovery = target.setTimeout(
    () => target.sessionStorage.removeItem(PRELOAD_RECOVERY_KEY),
    PRELOAD_RECOVERY_COOLDOWN_MS,
  );
  const onPreloadError = (event: Event) => {
    if (target.sessionStorage.getItem(PRELOAD_RECOVERY_KEY)) return;
    event.preventDefault();
    target.sessionStorage.setItem(PRELOAD_RECOVERY_KEY, "1");
    target.location.reload();
  };

  target.addEventListener("vite:preloadError", onPreloadError);
  return () => {
    target.clearTimeout(clearRecovery);
    target.removeEventListener("vite:preloadError", onPreloadError);
  };
}
