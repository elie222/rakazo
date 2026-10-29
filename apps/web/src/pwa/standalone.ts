type StandaloneHost = Pick<Window, "document" | "matchMedia"> & {
  navigator: Navigator & { standalone?: boolean };
};

/**
 * The installed app should not pinch, double-tap or focus-zoom like a web page.
 * Browser tabs keep zoom. iOS ignores `user-scalable=no` for pinches, so its
 * gesture events are cancelled too.
 */
export function lockStandaloneZoom(target: StandaloneHost = window): void {
  const standalone =
    target.navigator.standalone === true ||
    (typeof target.matchMedia === "function" &&
      target.matchMedia("(display-mode: standalone)").matches);
  if (!standalone) return;
  const { document } = target;
  const viewport = document.querySelector('meta[name="viewport"]');
  viewport?.setAttribute(
    "content",
    `${viewport.getAttribute("content")}, maximum-scale=1, user-scalable=no`,
  );
  document.documentElement.style.touchAction = "manipulation";
  for (const type of ["gesturestart", "gesturechange"]) {
    document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  }
}
