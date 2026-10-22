// Expo's native view adapter uses this same lookup. Unlike requireNativeView, it
// neither registers a component nor renders an incomplete config for missing views.
const availableViews = new Map<string, boolean>();

export function isComposeViewAvailable(viewName: string): boolean {
  const cached = availableViews.get(viewName);
  if (cached !== undefined) return cached;
  let available = false;
  try {
    available = globalThis.expo?.getViewConfig?.("ExpoUI", viewName) != null;
  } catch {
    // Older binaries may not expose the lookup or the requested view.
  }
  availableViews.set(viewName, available);
  return available;
}
