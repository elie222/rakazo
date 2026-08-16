import { expect, type Page, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("two users are isolated and a bot completes durable work", async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();

  const stamp = Date.now();
  await signup(pageA, `ada-${stamp}@rakazo.test`, "password12", "Ada");
  await completeOnboarding(pageA, ["A bit of everything", "Clear and tight"]);
  await expect(pageA.getByText("Chief").first()).toBeVisible();

  await signup(pageB, `bob-${stamp}@rakazo.test`, "password12", "Bob");
  await completeOnboarding(pageB, ["Coding & repos", "Clear and tight"]);
  await expect(pageB.getByText("Chief").first()).toBeVisible();
  await expect(pageB.getByText("Ada")).toHaveCount(0);

  const composer = pageA.getByPlaceholder(/Message/);
  await composer.fill("write a file in your home called notes/result.txt that says isolation-ok");
  await pageA.keyboard.press("Enter");
  await expect(
    pageA.getByText(/writing that into my home|isolation-ok|handled/i).first(),
  ).toBeVisible({
    timeout: 30_000,
  });

  await pageA.reload();
  await expect(pageA.getByText(/isolation-ok|writing that into my home/i).first()).toBeVisible();

  await a.close();
  await b.close();
});

test("takeover, routine, plugins, and export are reachable", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `flow-${stamp}@rakazo.test`, "password12", "Flow");
  await completeOnboarding(page, ["A bit of everything", "Clear and tight"]);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("install the gsc cli and sign in");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/sign in to continue|protected input/i).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Take control" }).click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await page.getByRole("button", { name: "Release" }).last().click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeHidden();
  await expect(page.getByText(/signed in|session stays/i).first()).toBeVisible({ timeout: 30_000 });

  await page.getByText("+ New routine").click();
  await page.locator("label:has-text('Name') input").fill("Monday briefing");
  await page
    .locator("label:has-text('Instruction') textarea")
    .fill("write a file in your home called notes/result.txt that says routine-ok");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Monday briefing")).toBeVisible();

  await page.getByText("Plugins").click();
  await expect(page.getByPlaceholder("Search apps")).toBeVisible();
  await page.getByRole("button", { name: "Close plugins" }).click();

  await page.getByText("Chief").first().click();
  const gear = page.locator("button:has-text('⚙')");
  if (!(await gear.isVisible().catch(() => false))) {
    await page.getByTitle("Agent computer").click();
  }
  await gear.click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/chief-export\.json/i);
  await expect(page.getByRole("button", { name: "Delete bot" })).toBeVisible();
});

test("sign-in, spawn, and stop work in the shell", async ({ page }) => {
  const stamp = Date.now();
  const email = `shell-${stamp}@rakazo.test`;
  await signup(page, email, "password12", "Shell");
  await completeOnboarding(page, ["A bit of everything", "Clear and tight"]);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("spawn a bot named Scout to research venues");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary").getByRole("button", { name: /Scout/ })).toBeVisible({
    timeout: 30_000,
  });

  await page
    .getByRole("complementary")
    .getByRole("button", { name: /^Chief/ })
    .click();
  await composer.fill("keep working until I stop you");
  await page.keyboard.press("Enter");
  await expect(page.getByText("still working").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });

  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill("password12");
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  await expect(
    page.getByRole("complementary").getByRole("button", { name: /^Chief/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary").getByRole("button", { name: /Scout/ }),
  ).toBeVisible();
});

test("bot context menu pins, duplicates, edits, and confirms deletion", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `menu-${stamp}@rakazo.test`, "password12", "Menu");
  await completeOnboarding(page, ["A bit of everything", "Clear and tight"]);

  const chief = page.getByRole("button", { name: /Chief/ }).first();
  await chief.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Actions for Chief" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Edit Profile" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Mark as Unread" }).click();

  // Chief is the open bot, so the auto-read on window focus must not undo the manual mark.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await chief.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Mark as Read" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Mark as Read" }).click();

  await chief.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();

  await chief.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Unpin", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByText("Chief copy").first()).toBeVisible();

  const copy = page.getByRole("button", { name: /Chief copy/ }).first();
  await copy.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog", { name: "Delete Chief copy?" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await chief.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit Profile" }).click();
  await expect(page.locator("label:has-text('Name') input")).toHaveValue("Chief");
});

async function completeOnboarding(page: Page, answers: string[]) {
  await page.waitForURL(/\/(onboarding|app)/, { timeout: 20_000 });
  const heading = page.getByRole("heading", { name: /Connect a model|Create your first bot/ });
  const chief = page.getByText("Chief").first();
  await heading.or(chief).waitFor({ timeout: 20_000 });
  if ((await chief.isVisible().catch(() => false)) && page.url().includes("/app")) return;
  if (
    await page
      .getByRole("heading", { name: "Connect a model" })
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByRole("button", { name: "Skip for now" }).click();
  }
  if (
    await page
      .getByRole("heading", { name: "Create your first bot" })
      .isVisible()
      .catch(() => false)
  ) {
    await page.locator("label:has-text('Name') input").fill("Chief");
    await page.getByRole("button", { name: "Continue" }).click();
    for (const answer of answers) {
      await page.getByText(answer, { exact: true }).click();
    }
    await page.getByRole("button", { name: "Open Rakazo" }).click();
  }
  await page.waitForURL(/\/app/);
  await expect(page.getByText("Chief").first()).toBeVisible();
}

async function signup(page: Page, email: string, password: string, name: string) {
  await page.goto("/sign-up");
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
}
