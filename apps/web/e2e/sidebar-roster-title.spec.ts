import { expect, type Page, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function captureSidebarRoster(
  page: Page,
  testInfo: Parameters<typeof captureScreenshot>[1],
  name: string,
) {
  const aside = page.locator("aside").first();
  await expect(aside).toBeVisible();
  const box = await aside.boundingBox();
  if (box) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      path: screenshotPath,
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: Math.min(box.width + 24, 360),
        height: Math.min(Math.max(box.height * 0.55, 320), 480),
      },
    });
    await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
    return;
  }
  await captureScreenshot(page, testInfo, name);
}

test("sidebar roster shows bot title pill below the name", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `roster-title-${stamp}@rakazo.test`, "password12", "Roster Title");
  await completeOnboarding(page);

  const bot = await rpc<{ id: string; name: string }>(page, "bots/create", {
    name: "Long Research Assistant Name",
    title: "Research & outreach lead",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  await page.goto(`/app/${bot.id}`);
  await page.waitForURL(new RegExp(`/app/${bot.id}$`));

  const sidebar = page.locator("aside").first();
  const row = sidebar.locator(`[data-roster-bot-id="${bot.id}"]`);
  await expect(row).toBeVisible();

  const name = row.locator("[data-roster-bot-name]");
  const title = row.getByText("Research & outreach lead");
  await expect(name).toHaveText("Long Research Assistant Name");
  await expect(title).toBeVisible();

  const nameBox = await name.boundingBox();
  const titleBox = await title.boundingBox();
  expect(nameBox).toBeTruthy();
  expect(titleBox).toBeTruthy();
  if (nameBox && titleBox) {
    expect(titleBox.y).toBeGreaterThan(nameBox.y + nameBox.height - 2);
    expect(nameBox.width).toBeGreaterThan(80);
  }

  await captureSidebarRoster(page, testInfo, "sidebar-roster-title-pill");
});
