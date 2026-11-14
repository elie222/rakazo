export const message =
  "Do not sleep for a fixed time in a browser test. Wait on the condition instead: expect.poll, a locator assertion such as expect(locator).toBeVisible(), or page.waitForFunction.";

export const include = ["**/e2e/**/*.{ts,tsx,mts,js,mjs}", "**/*.spec.ts"];

export const pattern = /\bwaitForTimeout\(/g;
