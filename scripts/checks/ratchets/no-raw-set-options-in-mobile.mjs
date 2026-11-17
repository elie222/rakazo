export const message =
  "Do not set a mobile screen's header by hand with navigation.setOptions(...) in an effect. Call useScreenHeader({ title, action }) from apps/mobile/lib/screen-header.tsx: it owns the effect and its dependency list, keeps the native header button, and a press always runs the latest onPress. Only a header it cannot express (a search bar, a menu, several actions, a custom view) stays on setOptions.";

export const include = ["apps/mobile/**/*.{ts,tsx}"];

export const exclude = ["apps/mobile/lib/screen-header.tsx", "**/*.{test,spec}.*"];

export const pattern = /(?<![\w$])setOptions\s*(?:\?\.\s*)?\(/g;
