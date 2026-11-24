export const message =
  "Mobile and web app code may not import the @rakazo/logging root: it pulls in Node-only modules that Metro and the browser cannot bundle. Import the subpath you need, such as @rakazo/logging/best-effort or @rakazo/logging/monitoring.";

export const include = [
  "apps/mobile/**/*.{ts,tsx}",
  "apps/web/src/**/*.{ts,tsx}",
  // Both are compiled into a client bundle by the web app and Metro, so a root import breaks
  // the bundle exactly as it does in the app that imports them.
  "packages/chat-ui/src/**/*.{ts,tsx}",
  "packages/ui-web/src/**/*.{ts,tsx}",
];

export const pattern = /(?:from|import\s*\(?)\s*["']@rakazo\/logging["']/g;
