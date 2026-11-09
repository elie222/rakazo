/**
 * The system floating bubble: a native bubble over other apps, for the
 * computer screen. Android only — iOS has no windows over other apps, so
 * the library is a no-op there.
 *
 * What this is not: the bubble is an icon that reopens the app. It cannot
 * carry the live computer screen itself. That is the system floating
 * window below: a WindowManager overlay hosting the noVNC page, driven by
 * the local RakazoSystemFloat module. The bubble stays as the fallback
 * when the window module is not in the build.
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

/** The slice of the local RakazoSystemFloat module this file needs. */
export type SystemFloatWindowModule = {
  isSupported: () => Promise<boolean>;
  hasOverlayPermission: () => Promise<boolean>;
  requestOverlayPermission: () => void;
  show: (url: string, title: string, locale: string) => Promise<boolean>;
  updateUrl: (url: string) => Promise<void>;
  hide: () => Promise<void>;
  isShowing: () => Promise<boolean>;
};

let injectedWindow: SystemFloatWindowModule | null = null;
/** Test seam: an injected window module replaces the native one. */
export function setSystemFloatWindowModule(module: SystemFloatWindowModule | null): void {
  injectedWindow = module;
}

async function loadWindow(): Promise<SystemFloatWindowModule | null> {
  if (injectedWindow) return injectedWindow;
  // The native window loads on first use, not with every screen that imports this.
  try {
    const { requireOptionalNativeModule } = await import("expo-modules-core");
    return requireOptionalNativeModule<SystemFloatWindowModule>("RakazoSystemFloat");
  } catch {
    return null;
  }
}

/**
 * Shows the live computer screen in a system floating window over other
 * apps. "shown" when it is up; "no-permission" when the user has not
 * allowed drawing over other apps yet; "unsupported" when this build has
 * no window module. Either failure falls back to the bubble, then the
 * in-app float.
 */
export async function showSystemFloatWindow(
  url: string,
  title: string,
  locale: string,
): Promise<"shown" | "no-permission" | "unsupported"> {
  try {
    const module = await loadWindow();
    if (!module) return "unsupported";
    if (!(await module.hasOverlayPermission())) return "no-permission";
    const shown = await module.show(url, title, locale);
    return shown ? "shown" : "unsupported";
  } catch {
    return "unsupported";
  }
}

/** Points a running system window at a new screen URL, for capability rotation. */
export async function updateSystemFloatWindowUrl(url: string): Promise<void> {
  try {
    await (await loadWindow())?.updateUrl(url);
  } catch {
    // The window is gone; the next show starts it again.
  }
}

/** Hides the system floating window, if it is up. */
export async function hideSystemFloatWindow(): Promise<void> {
  try {
    await (await loadWindow())?.hide();
  } catch {
    // Already gone.
  }
}

/** True when this build can float the live computer screen over other apps. */
export async function systemFloatWindowSupported(): Promise<boolean> {
  try {
    const module = await loadWindow();
    return (await module?.isSupported()) ?? false;
  } catch {
    return false;
  }
}
