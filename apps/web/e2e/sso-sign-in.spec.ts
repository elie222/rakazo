import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("SSO-only sign-in shows the configured provider", async ({ page }, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: {
        sso: { name: "Example", availability: "available" },
        passwordAuth: false,
        passwordReset: false,
        resetUrl: null,
        billing: false,
      },
    }),
  );
  await page.goto("/sign-in");
  await expect(page.getByRole("button", { name: "Continue with Example" })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sso-sign-in");
});
