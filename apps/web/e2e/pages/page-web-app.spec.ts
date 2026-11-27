import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

test("a page opens on its own window, ready to install as an app", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signup(page, `page-web-app-${Date.now()}@rakazo.test`, "password12", "App Maker");
  await completeOnboarding(page);
  const title = "Packing list";
  const source = `function Packing() {
    return <Page title="Packing list">
      <Section heading="Bags"><Checklist items={[{ text: "Passport", done: false }, { text: "Charger", done: true }]} /></Section>
    </Page>;
  }
  export default Packing;`;
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill(
    `call save_page with ${JSON.stringify({ title, source, icon: "luggage", iconColor: "orange" })}\nthen say Done.`,
  );
  await composer.press("Enter");
  const card = page.getByTestId("page-card");
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await card.getByRole("button", { name: `Open ${title}` }).click();

  const [app] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Install app" }).click(),
  ]);
  await expect(app).toHaveURL(/\/page\/[^/?]+\?space=/);
  await expect(app).toHaveTitle(title);
  const manifest = await app.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifest).toMatch(/^\/api\/v1\/pages\/[^/]+\/app\.webmanifest\?space=/);
  const response = await app.request.get(manifest!);
  expect(await response.json()).toMatchObject({ name: title, display: "standalone" });
  await expect(
    app
      .locator(`iframe[title="${title}"]`)
      .contentFrame()
      .locator("iframe#preview")
      .contentFrame()
      .getByText("Passport"),
  ).toBeVisible();
  await captureScreenshot(app, testInfo, "page-web-app");
});
