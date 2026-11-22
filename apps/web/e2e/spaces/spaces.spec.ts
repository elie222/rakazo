import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openNewSpace,
  rpc,
  signup,
} from "../helpers/helpers";

test("a new space starts empty, is renamed in its settings, and is deleted with its bots", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `spaces-delete-${stamp}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);

  const sidebar = page.locator("aside").first();
  await openNewSpace(page);
  const dialog = page.getByRole("dialog", { name: "New space" });
  const name = dialog.getByLabel("Name");
  await name.fill("Typo space");
  const windowKeys = await page.evaluateHandle(() => {
    const keys: string[] = [];
    window.addEventListener("keydown", (event) => keys.push(event.key));
    return keys;
  });
  // These synthetic keyboard events exercise the browser event flags; they do not start an OS IME.
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    await name.dispatchEvent("keydown", { key: "Enter", ...composition });
    await name.dispatchEvent("keydown", { key: "Escape", ...composition });
    expect(await windowKeys.evaluate((keys) => keys.includes("Escape"))).toBe(false);
    await expect(dialog.getByRole("button", { name: "Create space", exact: true })).toBeEnabled();
  }
  await name.press("Enter");

  // The account already has Chief, so the new space starts empty with a way to add a bot.
  await page.waitForURL(/\/app/);
  await expect(sidebar.getByText("Typo space", { exact: true })).toBeVisible();
  await expect(
    page.locator("main").getByRole("button", { name: "New bot", exact: true }),
  ).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
  await captureScreenshot(page, testInfo, "new-space-empty");
  // One bot of its own, so deleting the space names what goes with it.
  const { spaces } = await rpc<{ spaces: Array<{ id: string; name: string }> }>(
    page,
    "spaces/list",
    {},
  );
  const typo = spaces.find((space) => space.name === "Typo space")!;
  const scout = await page.request.post("/rpc/bots/create", {
    headers: { "x-rakazo-space-id": typo.id },
    data: { json: { name: "Scout", description: "", notifyOnFinish: true, computerMode: "team" } },
  });
  expect(scout.ok()).toBe(true);
  await page.reload();
  const occupied = sidebar
    .locator('[data-sidebar-group^="space:"]')
    .filter({ hasText: "Typo space" });
  await expect(occupied.getByRole("button", { name: /^Scout/ })).toBeVisible();

  const gear = sidebar.getByRole("button", { name: "Settings for Typo space" });
  await page.mouse.move(1, 1);
  await expect(gear).toHaveCSS("opacity", "0");
  await occupied.getByRole("button", { name: /Collapse Typo space/ }).hover();
  await expect(gear).toHaveCSS("opacity", "1");
  await captureScreenshot(page, testInfo, "sidebar-space-settings-gear");

  // The gear opens the named Space's settings directly, including from the keyboard.
  await page.mouse.move(1, 1);
  await gear.press("Enter");
  const settings = page.getByTestId("user-settings");
  await expect(settings).toHaveAttribute("data-settings-section", "space");
  const spaceName = settings.getByTestId("space-settings").getByLabel("Name");
  await expect(spaceName).toHaveValue("Typo space");
  await spaceName.fill("Temporary");
  await captureScreenshot(page, testInfo, "space-settings-rename");
  await spaceName.press("Enter");
  await expect(settings.getByRole("heading", { name: "Temporary" })).toBeVisible();
  await expect(sidebar.getByText("Temporary", { exact: true })).toBeVisible();
  await expect(sidebar.getByText("Typo space", { exact: true })).toHaveCount(0);

  // Back leads to Spaces, which lists every Space and explains what one is.
  await settings.getByRole("button", { name: "Back", exact: true }).click();
  await expect(settings).toHaveAttribute("data-settings-section", "spaces");
  await expect(settings.getByTestId("settings-nav-spaces")).toHaveAttribute("aria-current", "page");
  await captureScreenshot(page, testInfo, "settings-spaces");
  await settings.getByRole("button", { name: "Manage Temporary" }).click();
  await expect(settings).toHaveAttribute("data-settings-section", "space");

  // An occupied space is deleted with its bots after one confirmation naming them.
  await settings.getByRole("button", { name: "Delete space" }).click();
  const deleteSpaceDialog = page.getByRole("alertdialog", {
    name: "Delete Temporary and its 1 bot?",
  });
  await expect(deleteSpaceDialog).toBeVisible();
  await captureScreenshot(page, testInfo, "delete-space-dialog");
  await deleteSpaceDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(sidebar.getByText("Temporary", { exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/onboarding/);
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
  await page.reload();
  await expect(sidebar.getByText("Temporary", { exact: true })).toHaveCount(0);

  // A stale onboarding URL recovers without duplicating the bot.
  await page.goto("/onboarding");
  await page.waitForURL(/\/app/);
  await expect(page).not.toHaveURL(/\/onboarding/);
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(1);

  // With one Space left, Spaces shows its members and a way to start another, not a page of its own.
  await page.goto("/app?settings=spaces");
  const single = page.getByTestId("user-settings");
  await expect(single.getByTestId("space-members-settings")).toBeVisible();
  await expect(single.getByRole("button", { name: "Invite" })).toBeVisible();
  await expect(single.getByRole("button", { name: "New private space" })).toBeVisible();
  await expect(single.getByRole("button", { name: /^Manage / })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "settings-spaces-single");
});

test("deleting the last bot in a space stays in the app after first use", {
  tag: "@nightly",
}, async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `spaces-empty-${stamp}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);
  const [chief] = await rpc<Array<{ id: string }>>(page, "bots/list", {});
  expect(chief).toBeTruthy();
  await rpc(page, "bots/archive", { botId: chief!.id });
  await page.reload();
  await expect(page).not.toHaveURL(/\/onboarding/);

  const sidebar = page.locator("aside").first();
  await openNewSpace(page);
  const dialog = page.getByRole("dialog", { name: "New space" });
  await dialog.getByLabel("Name").fill("Side");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await page.waitForURL(/\/app/);
  await expect(sidebar.getByText("Side", { exact: true })).toBeVisible();

  // Give the new space one bot, then delete it: the app must stay put instead of
  // forcing onboarding again.
  const { spaces } = await rpc<{ spaces: Array<{ id: string; name: string }> }>(
    page,
    "spaces/list",
    {},
  );
  const side = spaces.find((space) => space.name === "Side")!;
  const made = await page.request.post("/rpc/bots/create", {
    headers: { "x-rakazo-space-id": side.id },
    data: { json: { name: "Scout", description: "", notifyOnFinish: true, computerMode: "team" } },
  });
  expect(made.ok()).toBe(true);
  await page.reload();
  const sideBot = sidebar
    .locator('[data-sidebar-group^="space:"]')
    .filter({ hasText: "Side" })
    .getByRole("button", { name: /^Scout/ });
  await sideBot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("alertdialog", { name: /Delete Scout/ });
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(sideBot).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/onboarding/);
  await page.reload();
  await expect(page).not.toHaveURL(/\/onboarding/);
  await expect(sidebar.getByRole("button", { name: "Open Side" })).toBeVisible();
  await expect(
    page.locator("main").getByRole("button", { name: "New bot", exact: true }),
  ).toBeVisible();

  await sidebar.getByRole("button", { name: "Settings for Side" }).press("Enter");
  await page.getByTestId("space-settings").getByRole("button", { name: "Delete space" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete Side?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(sidebar.getByText("Side", { exact: true })).toHaveCount(0);
  await sidebar.getByRole("button", { name: /^Archived/ }).click();
  await expect(sidebar.getByText("Chief", { exact: true })).toBeVisible();
});

test("deleting every bot leaves an empty space instead of a new Chief", async ({ page }) => {
  await signup(page, `spaces-cleared-${Date.now()}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);
  const [chief] = await rpc<Array<{ id: string }>>(page, "bots/list", {});
  expect(chief).toBeTruthy();
  await rpc(page, "bots/remove", { botId: chief!.id });
  await page.goto("/app");
  await expect(
    page.locator("main").getByRole("button", { name: "New bot", exact: true }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/\/onboarding/);
  // A stale onboarding URL lands in the same empty space.
  await page.goto("/onboarding");
  await page.waitForURL(/\/app/);
  expect(await rpc<unknown[]>(page, "bots/list", {})).toEqual([]);
});
