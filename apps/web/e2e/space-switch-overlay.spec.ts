import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

for (const closeBeforeSwitch of [false, true]) {
  test(`a Skills dialog ${closeBeforeSwitch ? "closed" : "opened"} during a space switch stays ${closeBeforeSwitch ? "closed" : "open"}`, async ({
    page,
  }, testInfo) => {
    await signup(page, `space-overlay-${Date.now()}@rakazo.test`, "password12", "Space Owner");
    await completeOnboarding(page);
    const space = await rpc<{ id: string }>(page, "spaces/create", { name: "Second space" });
    const created = await page.request.post("/rpc/bots/create", {
      headers: { "x-rakazo-space-id": space.id },
      data: {
        json: { name: "Scout", description: "", notifyOnFinish: true, computerMode: "team" },
      },
    });
    expect(created.ok()).toBe(true);
    const { json: scout } = (await created.json()) as { json: { id: string } };
    await page.reload();
    const scoutButton = page.getByTestId("bots-sidebar").getByRole("button", { name: /^Scout/ });
    await expect(scoutButton).toBeVisible();

    let release = () => {};
    let signalStarted = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    await page.route("**/rpc/bootstrap", async (route) => {
      if (route.request().headers()["x-rakazo-space-id"] === space.id) {
        signalStarted();
        await held;
      }
      await route.continue();
    });
    try {
      await scoutButton.click();
      await started;
      await page.getByTestId("user-menu-trigger").click();
      await page
        .locator('[data-slot="popover-content"]')
        .filter({ has: page.getByTestId("account-menu-header") })
        .getByRole("button", { name: "Skills", exact: true })
        .click();
      const skills = page.getByRole("dialog", { name: "Skills", exact: true });
      await expect(skills).toBeVisible();
      if (closeBeforeSwitch) {
        await page.keyboard.press("Escape");
        await expect(skills).toBeHidden();
      }
      release();
      await page.waitForURL((url) => url.pathname === `/app/${scout.id}`);
      if (closeBeforeSwitch) {
        await expect(skills).toBeHidden();
        expect(new URL(page.url()).searchParams.has("skills")).toBe(false);
      } else {
        await expect(skills).toBeVisible();
        expect(new URL(page.url()).searchParams.has("skills")).toBe(true);
        await captureScreenshot(page, testInfo, "space-switch-skills");
      }
    } finally {
      release();
    }
  });
}
