export const message =
  "Mobile and web app code may not import the @rakazo/logging root: it pulls in Node-only modules that Metro and the browser cannot bundle. Import the subpath you need, such as @rakazo/logging/best-effort or @rakazo/logging/monitoring.";

export const include = ["apps/mobile/**/*.{ts,tsx}", "apps/web/src/**/*.{ts,tsx}"];

export const pattern = /(?:from|import\s*\(?)\s*["']@rakazo\/logging["']/g;
