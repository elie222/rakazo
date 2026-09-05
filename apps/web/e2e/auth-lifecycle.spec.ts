import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("restricted signup waits for mailbox verification", async ({ page }, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: { passwordReset: false, resetUrl: null },
    }),
  );
  await page.route("**/api/auth/sign-up/email", (route) =>
    route.fulfill({
      json: { token: null, user: { id: "pending-user", emailVerified: false } },
    }),
  );
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Pending User");
  await page.getByLabel("Email").fill("pending@example.test");
  await page.getByLabel("Password", { exact: true }).fill("password12");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page).toHaveURL(/\/sign-up\?verify=email$/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await captureScreenshot(page, testInfo, "signup-verification-required");
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
});

test("logout protects bot deep links and sign-in restores the session", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const email = `auth-lifecycle-${stamp}@rakazo.test`;
  const password = "password12";
  const userName = "Auth Lifecycle";

  await page.goto("/sign-up");
  await expect(page.getByLabel("Name")).toHaveAttribute("autocomplete", "name");
  await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "username");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "autocomplete",
    "new-password",
  );

  await signup(page, email, password, userName);
  await completeOnboarding(page);

  await page.waitForURL(/\/app\/[^/]+$/);
  const protectedBotPath = new URL(page.url()).pathname;
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();

  await page.getByRole("button", { name: new RegExp(userName, "i") }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await captureScreenshot(page, testInfo, "36-account-menu");

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByText(/Your team of always-on agents/)).toBeVisible();
  await page.getByRole("button", { name: /Sign up/ }).click();
  await expect(page).toHaveURL(/\/sign-up$/);
  await expect(page.getByRole("heading", { name: "Create your Rakazo" })).toBeVisible();
  await page.goto("/");
  await captureScreenshot(page, testInfo, "37-logged-out-welcome");

  await page.goto(protectedBotPath);
  await page.waitForURL((url) => url.pathname === "/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  await expect(page.getByText("Chief", { exact: true })).toHaveCount(0);
  await expect(page.getByText(userName, { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "username");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "autocomplete",
    "current-password",
  );
  await captureScreenshot(page, testInfo, "38-protected-deep-link-sign-in");

  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill("wrong-password12");
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect(
    page
      .locator("form")
      .getByText(/invalid email or password|invalid credentials|incorrect password/i),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
  await captureScreenshot(page, testInfo, "39-invalid-credentials");

  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.waitForURL((url) => url.pathname === protectedBotPath, {
    timeout: 20_000,
  });
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await expect(composer).toHaveAttribute("name", "chat-message");
  await expect(composer).toHaveAttribute("autocomplete", "off");
  await expect(composer).toHaveAttribute("aria-label", "Message Chief");
  await expect(page.getByRole("button", { name: new RegExp(userName, "i") })).toBeVisible();

  await composer.fill("line one");
  const heightBeforeNewline = await composer.evaluate((el) => el.getBoundingClientRect().height);
  await composer.press("Shift+Enter");
  await composer.type("line two");
  await expect(composer).toHaveValue("line one\nline two");
  const heightWithNewline = await composer.evaluate((el) => el.getBoundingClientRect().height);
  expect(heightWithNewline).toBeGreaterThan(heightBeforeNewline);

  await composer.press("Enter");
  const multilineMessage = page
    .getByTestId("transcript")
    .getByText("line one\nline two", { exact: true });
  await expect(multilineMessage).toBeVisible();
  await expect(multilineMessage).toHaveCSS("white-space", "pre-wrap");

  const message = "Fake composer regression check.";
  await composer.fill(message);
  await captureScreenshot(page, testInfo, "40-restored-auth-session");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  // Scope to the transcript: the sidebar activity row can echo the same text.
  await expect(page.getByTestId("transcript").getByText(message, { exact: true })).toBeVisible();
});

test("changes and recovers an email password", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const email = `password-recovery-${stamp}@rakazo.test`;
  const originalPassword = "password12";
  const changedPassword = "changed-password12";
  const resetPassword = "reset-password12";
  const userName = "Password Recovery";

  await signup(page, email, originalPassword, userName);
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await settings.getByLabel("Current password").fill(originalPassword);
  await settings.getByLabel("New password").fill(changedPassword);
  await settings.getByLabel("Confirm password").fill(changedPassword);
  await settings.getByRole("button", { name: "Change password" }).click();
  await expect(settings.getByText("Password updated")).toBeVisible();
  await captureScreenshot(page, testInfo, "41-password-changed");
  await settings.getByRole("button", { name: "Close user settings" }).click();

  await page.getByRole("button", { name: new RegExp(userName, "i") }).click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("link", { name: "Forgot password?" })).toBeVisible();
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await expect(page.getByLabel("Email")).toHaveValue(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reset your password" })).not.toBeVisible();
  await captureScreenshot(page, testInfo, "42-password-reset-requested");

  const emailApi = process.env.API_URL ?? "http://127.0.0.1:3110";
  await expect
    .poll(async () => {
      const response = await page.request.get(`${emailApi}/__e2e/emails`);
      return ((await response.json()) as unknown[]).length;
    })
    .toBeGreaterThan(0);
  const messagesResponse = await page.request.get(`${emailApi}/__e2e/emails`);
  expect(messagesResponse.headers()["cache-control"]).toBe("no-store");
  const messages = (await messagesResponse.json()) as Array<{
    text: string;
  }>;
  const resetUrl = messages.at(-1)?.text.match(/https?:\/\/\S+/)?.[0];
  expect(resetUrl).toBeTruthy();

  await page.goto(resetUrl!);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await page.getByLabel("New password").fill(resetPassword);
  await page.getByLabel("Confirm password").fill(resetPassword);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText("Password updated")).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(resetPassword);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.waitForURL(/\/app(?:\/|$)/);
});
