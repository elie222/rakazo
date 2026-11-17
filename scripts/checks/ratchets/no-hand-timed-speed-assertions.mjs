export const message =
  "Do not time a test by hand against a fixed bound. To show code runs in linear time, use expectLinearTime from @rakazo/contracts/test-timing and size the input so a backtracking version would take far longer; to show a wait ends early, hold it with deferred() or fake timers instead of reading the clock.";

export const include = [
  "{packages,apps,scripts,infra}/**/*.{test,spec}.{ts,tsx,mts,cts,js,mjs,cjs}",
];

export const exclude = ["scripts/checks/no-hand-timed-speed-assertions.test.mjs"];

const clock = String.raw`(?:performance|Date)\.now\(\)\s*-\s*[\w.]+\s*`;
const assertionMessage = String.raw`(?:,\s*(?:"[^"\n]*"|'[^'\n]*'|\`[^\`\n]*\`)\s*)?`;
const upperBound = String.raw`\)\s*\.toBeLessThan(?:OrEqual)?\(`;

/** The clock read inside `expect(...)`, or kept in a variable that a later `expect` bounds. */
export const pattern = new RegExp(
  `${clock}${assertionMessage}${upperBound}|\\b(\\w+)\\s*=\\s*${clock};[\\s\\S]{0,500}?\\bexpect\\(\\s*\\1\\b\\s*${assertionMessage}${upperBound}`,
  "g",
);
