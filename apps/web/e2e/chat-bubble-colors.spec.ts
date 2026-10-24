import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("colored user bubbles keep white text in both themes", async ({ page }, testInfo) => {
  await signup(page, `bubble-colors-${Date.now()}@rakazo.test`, "password12", "Bubble Demo");
  await completeOnboarding(page);
  await rpc(page, "bots/update", { botId: activeBotId(page), color: "#A855F7" });
  await page.reload();

  const message = "Let's plan the week ahead.";
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill(message);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const bubble = page.getByTestId("message-user-bubble").filter({ hasText: message });
  await expect(bubble).toBeVisible();

  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => localStorage.setItem("rakazo.uiAppearance", theme), theme);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(bubble).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(bubble).toHaveCSS("background-color", "rgb(151, 76, 222)");
    await captureScreenshot(page, testInfo, `chat-bubble-white-text-${theme}`);
  }
});
