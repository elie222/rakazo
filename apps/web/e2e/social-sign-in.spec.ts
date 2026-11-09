import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const passwordOnly = {
  passwordAuth: true,
  sso: null,
  passwordReset: false,
  resetUrl: null,
  providers: [],
};

test("sign-in and sign-up show Google and Apple when the server enables them", async ({
  page,
}, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ status: 404, json: { message: "not called" } }),
  );
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: {
        ...passwordOnly,
        providers: [
          { id: "google", name: "Google" },
          { id: "apple", name: "Apple", native: true },
        ],
      },
    }),
  );
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Apple" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByText("or", { exact: true })).toBeVisible();
  const googleBox = await page.getByRole("button", { name: "Continue with Google" }).boundingBox();
  const emailBox = await page.getByLabel("Email", { exact: true }).boundingBox();
  expect(googleBox && emailBox && googleBox.y < emailBox.y).toBeTruthy();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await captureScreenshot(page, testInfo, "sign-in-google-apple");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Continue with Apple" })).toBeVisible();
  await captureScreenshot(page, testInfo, "sign-in-google-apple-dark");
  await page.emulateMedia({ colorScheme: "light" });

  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Create your Rakazo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Apple" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create account", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "sign-up-google-apple");
});

test("sign-in hides social buttons when none are configured", async ({ page }, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) => route.fulfill({ json: passwordOnly }));
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue with/ })).toHaveCount(0);
  await expect(page.getByText("or", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sign-in-no-social");
});
