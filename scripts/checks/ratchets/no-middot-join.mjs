export const message =
  "Do not join user-facing text with a middle dot. Render the secondary value as its own muted element or row instead of joining text with a separator.";

export const include = [
  "apps/web/src/**/*.{ts,tsx}",
  "apps/mobile/{app,components,lib}/**/*.{ts,tsx}",
  "packages/{ui-web,chat-ui,page-kit}/**/*.{ts,tsx}",
];

export const exclude = ["**/*.{test,spec}.*"];

export const pattern = /·|&middot;|\\u00b7/gi;
