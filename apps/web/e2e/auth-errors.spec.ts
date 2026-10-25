import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("sign-in shows translated password and callback errors", async ({ page }, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: { passwordAuth: true, sso: null, passwordReset: false, resetUrl: null },
    }),
  );
  await page.route("**/api/auth/sign-in/email", (route) =>
    route.fulfill({
      status: 403,
      json: { code: "PASSWORD_AUTH_DISABLED", message: "PASSWORD_AUTH_DISABLED" },
    }),
  );

  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill("user@example.test");
  await page.getByLabel("Password", { exact: true }).fill("password12");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .getByText("Password sign-in is turned off on this server", { exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "sign-in-password-auth-disabled");

  await page.goto("/sign-in?error=REGISTRATION_CLOSED");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(
    page.getByRole("alert").getByText("Registration is closed", { exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "sign-in-registration-closed");
});
