import { expect, type Page, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, openNewBot, signup } from "./helpers";

test("View… peeks another bot's computer read-only", async ({ page }, testInfo) => {
  const stamp = Date.now();

  await signup(page, `computer-peek-${stamp}@rakazo.test`, "password12", "Computer Peek");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);

  await createBot(page, "Writer", "team");
  await openBot(page, "Chief");
  expect(activeBotId(page)).toBe(chiefId);

  await openComputerPanel(page);
  const panel = page.getByTestId("side-panel");
  await panel.getByRole("button", { name: "View another computer" }).click();
  const picker = panel.getByRole("button", { name: "Writer", exact: true });
  await expect(picker).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-peek-picker");

  await picker.click();
  await expect(panel.getByRole("button", { name: "Back to your computer" })).toBeVisible();
  await expect(panel.getByText("Viewing Writer (read only)", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-peek-view");
});

async function createBot(page: Page, name: string, mode: "team" | "dedicated") {
  await openNewBot(page);
  await expect(page.getByText("New bot", { exact: true })).toBeVisible();
  const team = page.getByRole("button", { name: "Team", exact: true });
  const privateComputer = page.getByRole("button", { name: "Private", exact: true });
  await expect(team).toHaveAttribute("aria-pressed", "true");
  if (mode === "dedicated") await privateComputer.click();
  await expect(mode === "team" ? team : privateComputer).toHaveAttribute("aria-pressed", "true");
  await page.getByPlaceholder("Name this bot").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
  return activeBotId(page);
}

async function openBot(page: Page, name: string) {
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
}

async function openComputerPanel(page: Page) {
  await page.getByTitle("Agent computer").click();
  await expect(page.getByRole("button", { name: "Take control", exact: true })).toBeVisible();
}
