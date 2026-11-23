export const message =
  "Do not use the browser's own select menu in the web app. Use OptionSelect from @rakazo/ui-web for a dropdown over a fixed list, so every dropdown opens the app's own menu and looks and behaves the same.";

export const include = ["apps/web/src/**/*.{ts,tsx}", "packages/ui-web/src/**/*.{ts,tsx}"];

export const exclude = ["**/*.{test,spec}.*"];

export const pattern = /\bNativeSelect\w*\b|<select[\s>/]/g;
