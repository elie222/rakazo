export const message =
  "Do not sleep with a raw timer. Use abortableDelay(ms, signal) from @rakazo/core so cancelling a run interrupts the wait; to wait for a condition use pollUntil, and to wait between attempts use retry.";

export const include = [
  "{packages/{adapters,core,db,auth,memory,logging},apps/{api,worker},infra/sandboxes/supervisor,infra/updater}/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
];

export const exclude = [
  "**/*.{test,spec}.*",
  "**/*{.,-}test-support.*",
  "**/testing/**",
  "packages/core/src/primitives/{async,retry,retry-policy}.ts",
];

// The promise-returning setTimeout (or scheduler.wait) from the timers module, however it is named.
const TIMERS_IMPORT = String.raw`import\s*(?:\{[^}]*\b(?:setTimeout|scheduler)\b[^}]*\}|\*\s*as\s+\w+|\w+)\s*from\s*["'](?:node:)?timers\/promises["']`;
// A promise whose executor does nothing but resolve it from a timer.
const TIMER_PROMISE = String.raw`new Promise(?:<[^>]*>)?\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{?\s*setTimeout\(\s*(?:\1|\(\)\s*=>\s*\1\([^()]*\))\s*,[^;{}]*?\)(?:\.unref\??\.?\(\))?\s*;?\s*\}?\s*,?\s*\)`;

export const pattern = new RegExp(`${TIMERS_IMPORT}|${TIMER_PROMISE}`, "g");
