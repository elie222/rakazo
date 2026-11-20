// The seeded account creates a bot from the create menu and from the command menu.
export default async function ({ page, expect, capture, signIn }) {
  await signIn();
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible({ timeout: 30_000 });
  const stamp = Date.now() % 100_000;
  const dialog = page.getByTestId("create-bot-dialog");
  const sidebar = page.getByTestId("bots-sidebar");

  const fromMenu = `Menu Bot ${stamp}`;
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-bot").click();
  await create(fromMenu);
  await capture("from-create-menu");

  const fromPalette = `Palette Bot ${stamp}`;
  await page.keyboard.press("ControlOrMeta+K");
  await page
    .getByRole("dialog", { name: "Command menu" })
    .getByRole("option", { name: "New bot" })
    .click();
  await create(fromPalette);

  await page.reload();
  for (const name of [fromMenu, fromPalette]) {
    await expect(sidebar.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible({
      timeout: 30_000,
    });
  }
  await capture("after-reload");

  async function create(name: string) {
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder("Name your Bot").fill(name);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
  }
}
