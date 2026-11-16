export const message =
  "Do not time a test by hand against a fixed bound. To show code runs in linear time, use expectLinearTime from @rakazo/contracts/test-timing and size the input so a backtracking version would take far longer; to show a wait ends early, hold it with deferred() or fake timers instead of reading the clock.";

export const include = [
  "{packages,apps,scripts,infra}/**/*.{test,spec}.{ts,tsx,mts,cts,js,mjs,cjs}",
];

export const exclude = ["scripts/checks/no-hand-timed-speed-assertions.test.mjs"];

export const pattern =
  /\b(?:performance|Date)\.now\(\)\s*-\s*[\w.]+\s*\)\s*\.toBeLessThan(?:OrEqual)?\(/g;
