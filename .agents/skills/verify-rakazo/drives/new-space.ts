// The seeded account creates Spaces from the create menu and the command menu, each with its own
// Chief, and renames one from its settings.
export default async function ({ page, expect, capture, signIn }) {
  await signIn();
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible({ timeout: 30_000 });
  const stamp = Date.now() % 100_000;
  const dialog = page.getByRole("dialog", { name: "New space" });
  const sidebar = page.locator("aside").first();
  const space = (name: string) =>
    sidebar.locator('[data-sidebar-group^="space:"]').filter({ hasText: name });

  const fromMenu = `Menu Space ${stamp}`;
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-space").click();
  await dialog.getByLabel("Name").fill(fromMenu);
  await capture("dialog");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(space(fromMenu).getByRole("button", { name: /^Chief/ })).toBeVisible({
    timeout: 30_000,
  });

  const fromPalette = `Palette Space ${stamp}`;
  await page.keyboard.press("ControlOrMeta+K");
  await page
    .getByRole("dialog", { name: "Command menu" })
    .getByRole("option", { name: "New private space" })
    .click();
  await dialog.getByLabel("Name").fill(fromPalette);
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(space(fromPalette).getByRole("button", { name: /^Chief/ })).toBeVisible({
    timeout: 30_000,
  });
  await capture("created");

  await sidebar.getByRole("button", { name: `Actions for ${fromMenu}` }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settings = page.getByTestId("user-settings");
  const field = settings.getByTestId("space-settings").getByLabel("Name");
  await expect(field).toHaveValue(fromMenu);
  await field.fill(`${fromMenu} renamed`);
  await field.press("Enter");
  await expect(settings.getByRole("heading", { name: `${fromMenu} renamed` })).toBeVisible();
  await page.reload();
  await expect(sidebar.getByText(`${fromMenu} renamed`, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await capture("renamed");
}
