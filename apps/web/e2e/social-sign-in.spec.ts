import type { Page } from "@playwright/test";
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

async function mockSignedOut(page: Page, providers: typeof both | []) {
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
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByText("Sign in to continue to Rakazo")).toBeVisible();
  const google = page.getByRole("button", { name: "Continue with Google" });
  const apple = page.getByRole("button", { name: "Continue with Apple" });
  const emailChoice = page.getByRole("button", { name: "Continue with email" });
  await expect(google).toBeVisible();
  await expect(apple).toBeVisible();
  await expect(emailChoice).toBeVisible();
  await expect(page.getByText("or", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign up" })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  const googleBox = await google.boundingBox();
  const appleBox = await apple.boundingBox();
  const emailBox = await emailChoice.boundingBox();
  expect(googleBox && appleBox && Math.abs(googleBox.y - appleBox.y) < 4).toBeTruthy();
  expect(googleBox && appleBox && googleBox.x < appleBox.x).toBeTruthy();
  expect(googleBox && appleBox && Math.abs(googleBox.width - appleBox.width) < 2).toBeTruthy();
  expect(googleBox && googleBox.height >= 44 && googleBox.height <= 52).toBeTruthy();
  expect(emailBox && googleBox && emailBox.y > googleBox.y).toBeTruthy();
  expect(emailBox && googleBox && emailBox.width < googleBox.width * 0.85).toBeTruthy();
  expect(emailBox && googleBox && emailBox.height < googleBox.height).toBeTruthy();

  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await captureScreenshot(page, testInfo, "sign-in-chooser");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureScreenshot(page, testInfo, "sign-in-chooser-dark");
  await page.emulateMedia({ colorScheme: "light" });

  await emailChoice.click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Forgot password?" })).toBeVisible();
  const back = page.getByRole("button", { name: "Back", exact: true });
  await expect(back).toBeVisible();
  await expect(back.locator("svg")).toBeVisible();
  await expect(google).toHaveCount(0);
  const backBox = await back.boundingBox();
  const emailField = await page.getByLabel("Email", { exact: true }).boundingBox();
  expect(backBox && emailField && Math.abs(backBox.x - emailField.x) < 24).toBeTruthy();
  await captureScreenshot(page, testInfo, "sign-in-email");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureScreenshot(page, testInfo, "sign-in-email-dark");
  await page.emulateMedia({ colorScheme: "light" });

  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Create your Rakazo" })).toBeVisible();
  await expect(page.getByText("Persistent AI teammates that do real work")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Apple" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sign-up-chooser");
});

test("one provider spans the chooser row", async ({ page }, testInfo) => {
  await mockSignedOut(page, [{ id: "google", name: "Google" }]);
  await page.goto("/sign-in");
  const google = page.getByRole("button", { name: "Continue with Google" });
  const emailChoice = page.getByRole("button", { name: "Continue with email" });
  await expect(google).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Apple" })).toHaveCount(0);
  const googleBox = await google.boundingBox();
  const emailBox = await emailChoice.boundingBox();
  const card = page.locator("form");
  const cardBox = await card.boundingBox();
  expect(googleBox && cardBox && googleBox.width > cardBox.width * 0.7).toBeTruthy();
  expect(emailBox && googleBox && emailBox.width < googleBox.width * 0.85).toBeTruthy();
  await captureScreenshot(page, testInfo, "sign-in-one-provider");
});

test("sign-in hides the chooser when none are configured", async ({ page }, testInfo) => {
  await mockSignedOut(page, []);
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  await expect(page.getByText("Welcome back")).toHaveCount(0);
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with email" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue with Google" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sign-in-no-social");
});

test("chooser stacks the providers on a phone", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSignedOut(page, both);
  await page.goto("/sign-in");
  const google = page.getByRole("button", { name: "Continue with Google" });
  const apple = page.getByRole("button", { name: "Continue with Apple" });
  await expect(google).toBeVisible();
  const googleBox = await google.boundingBox();
  const appleBox = await apple.boundingBox();
  expect(googleBox && appleBox && appleBox.y > googleBox.y + 20).toBeTruthy();
  expect(googleBox && appleBox && Math.abs(googleBox.width - appleBox.width) < 2).toBeTruthy();
  await captureScreenshot(page, testInfo, "sign-in-chooser-mobile");
});
