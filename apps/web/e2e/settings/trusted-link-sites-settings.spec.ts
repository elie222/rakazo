import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "../helpers/helpers";

test("lists a trusted site in Settings and removes it", async ({ page }, testInfo) => {
  await signup(page, `trusted-sites-${Date.now()}@rakazo.test`, "password12", "Trusted sites");
  await completeOnboarding(page);
  await rpc(page, "trustedLinkSites/trust", { url: "https://example.com/" });
  const settings = await openUserSettings(page);
  const group = settings.getByTestId("trusted-link-sites");
  const remove = group.getByRole("button", { name: "Remove example.com", exact: true });
  await expect(remove).toBeEnabled();
  await remove.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "trusted-link-sites-settings");
  await remove.click();
  await expect(remove).toHaveCount(0);
});
