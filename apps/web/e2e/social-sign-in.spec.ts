import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const passwordOnly = {
  passwordAuth: true,
  sso: null,
  passwordReset: true,
  resetUrl: "http://127.0.0.1:5173/reset-password",
  providers: [] as { id: string; name: string; native?: boolean }[],
};

const both = [
  { id: "google", name: "Google" },
  { id: "apple", name: "Apple", native: true },
];

async function mockSignedOut(page: import("@playwright/test").Page, providers: typeof both | []) {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ status: 404, json: { message: "not called" } }),
  );
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({ json: { ...passwordOnly, providers } }),
  );
}

test("sign-in offers Google and Apple before email", async ({ page }, testInfo) => {
  await mockSignedOut(page, both);
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  const google = page.getByRole("button", { name: "Google", exact: true });
  const apple = page.getByRole("button", { name: "Apple", exact: true });
  const emailChoice = page.getByRole("button", { name: "Continue with email" });
  await expect(google).toBeVisible();
  await expect(apple).toBeVisible();
  await expect(emailChoice).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  const googleBox = await google.boundingBox();
  const appleBox = await apple.boundingBox();
  const emailBox = await emailChoice.boundingBox();
  expect(googleBox && appleBox && Math.abs(googleBox.y - appleBox.y) < 4).toBeTruthy();
  expect(googleBox && appleBox && googleBox.x < appleBox.x).toBeTruthy();
  expect(googleBox && appleBox && Math.abs(googleBox.width - appleBox.width) < 2).toBeTruthy();
  expect(emailBox && googleBox && emailBox.y > googleBox.y).toBeTruthy();
  expect(emailBox && googleBox && emailBox.width > googleBox.width).toBeTruthy();

  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await captureScreenshot(page, testInfo, "sign-in-chooser");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureScreenshot(page, testInfo, "sign-in-chooser-dark");
  await page.emulateMedia({ colorScheme: "light" });

  await emailChoice.click();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Forgot password?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  await expect(google).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sign-in-email");

  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Create your Rakazo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Google", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apple", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sign-up-chooser");
});

test("one provider spans the chooser row", async ({ page }, testInfo) => {
  await mockSignedOut(page, [{ id: "google", name: "Google" }]);
  await page.goto("/sign-in");
  const google = page.getByRole("button", { name: "Google", exact: true });
  const emailChoice = page.getByRole("button", { name: "Continue with email" });
  await expect(google).toBeVisible();
  await expect(page.getByRole("button", { name: "Apple", exact: true })).toHaveCount(0);
  const googleBox = await google.boundingBox();
  const emailBox = await emailChoice.boundingBox();
  expect(googleBox && emailBox && Math.abs(googleBox.width - emailBox.width) < 2).toBeTruthy();
  await captureScreenshot(page, testInfo, "sign-in-one-provider");
});

test("sign-in hides the chooser when none are configured", async ({ page }, testInfo) => {
  await mockSignedOut(page, []);
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with email" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Google", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sign-in-no-social");
});
