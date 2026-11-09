/**
 * The system floating bubble: a native bubble over other apps, for the
 * computer screen. Android only — iOS has no windows over other apps, so
 * the library is a no-op there.
 *
 * What this is not: the bubble is an icon that reopens the app. It cannot
 * carry the live computer screen itself — that needs a custom native module
 * (a WindowManager overlay hosting a WebView, fed by a foreground service),
 * which does not exist in this codebase. Tapping the bubble brings the app
 * back, with the in-app float still where it was.
 */

/** The slice of react-native-android-floating-bubble this module needs. */
export type FloatingBubbleModule = {
  isSupported: () => boolean;
  hasOverlayPermission: () => boolean;
  requestOverlayPermission: () => void;
  show: (badgeCount?: number) => void;
  hide: () => void;
};

let injected: FloatingBubbleModule | null = null;
/** Test seam: an injected bubble replaces the native module. */
export function setFloatingBubbleModule(module: FloatingBubbleModule | null): void {
  injected = module;
}

async function load(): Promise<FloatingBubbleModule | null> {
  if (injected) return injected;
  // The native bubble loads on first use, not with every screen that imports this.
  try {
    const { FloatingBubble } = await import("react-native-android-floating-bubble");
    return FloatingBubble as unknown as FloatingBubbleModule;
  } catch {
    return null;
  }
}

/** True when the user allowed this app to draw over other apps. */
export async function systemFloatHasPermission(): Promise<boolean> {
  try {
    const module = await load();
    return module?.hasOverlayPermission() ?? false;
  } catch {
    return false;
  }
}

/** Opens the system screen where the user grants the overlay permission. */
export async function requestSystemFloatPermission(): Promise<void> {
  try {
    (await load())?.requestOverlayPermission();
  } catch {
    // The settings screen never opened; the caller keeps the in-app float.
  }
}

/**
 * Shows the bubble over other apps. "shown" when it is up; "no-permission"
 * when the user has not allowed it yet; "unsupported" when the device
 * cannot float or this build has no bubble. Either failure leaves the
 * in-app float as the fallback.
 */
export async function showSystemFloat(): Promise<"shown" | "no-permission" | "unsupported"> {
  try {
    const module = await load();
    if (!module?.isSupported()) return "unsupported";
    if (!module.hasOverlayPermission()) return "no-permission";
    module.show();
    return "shown";
  } catch {
    return "unsupported";
  }
}

/** Hides the bubble, if it is up. */
export async function hideSystemFloat(): Promise<void> {
  try {
    (await load())?.hide();
  } catch {
    // Already gone.
  }
}
