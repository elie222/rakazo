import { expect, test } from "@playwright/test";
import { completeOnboarding, openBotPanel, signup } from "../helpers/helpers";

test("chat details opens without animating its width when reduced motion is requested", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signup(page, `panel-motion-${Date.now()}@rakazo.test`, "password12", "Panel Motion");
  await completeOnboarding(page);

  const panel = page.getByTestId("side-panel");
  const separator = page.getByRole("separator", { name: "Resize panel" });
  await expect(panel).toHaveCSS("width", "0px");
  await expect(panel).toHaveCSS("transition-property", "none");
  await openBotPanel(page);
  await expect(panel).toHaveCSS("width", "384px");
  await expect(panel).toHaveCSS("transition-property", "none");

  await separator.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "320");
  await expect(panel).toHaveCSS("width", "320px");
  await separator.press("ArrowLeft");
  await expect(panel).toHaveCSS("width", "352px");

  await page.getByTestId("bot-settings-trigger").click();
  await expect(panel).toHaveCSS("width", "0px");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openBotPanel(page);
  await expect(panel).toHaveCSS("width", "352px");
  await expect(panel).toHaveCSS("transition-property", "width");
  await expect(panel).toHaveCSS("transition-duration", "0.15s");
});
