// A new person signs up through the form, lands in Chief, logs out, and signs back in.
export default async function ({ page, expect, capture, signUp }) {
  const { email, password } = await signUp();
  await page.waitForURL(/\/(onboarding|app)/);
  const integrations = page.getByRole("heading", { name: "Server integrations", exact: true });
  const composer = page.getByPlaceholder("Message Chief");
  await expect(integrations.or(composer)).toBeVisible({ timeout: 30_000 });
  if (await integrations.isVisible()) {
    await capture("integrations-step");
    await page.getByRole("button", { name: "Skip", exact: true }).click();
  }
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await capture("first-chat");

  await page.getByRole("button", { name: /^Account menu for/ }).click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  await capture("logged-out");

  const continueWithEmail = page.getByRole("button", { name: "Continue with email" });
  const emailField = page.getByPlaceholder("Your email address");
  await expect(emailField.or(continueWithEmail)).toBeVisible();
  if (await continueWithEmail.isVisible()) await continueWithEmail.click();
  await emailField.fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/app\//);
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await capture("signed-back-in");
}
