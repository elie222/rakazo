import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("sidebar search opens from its icon and closes without moving chats mid-click", async ({
  page,
}, testInfo) => {
  await signup(page, `sidebar-search-${Date.now()}@rakazo.test`, "password12", "Search Sample");
  await completeOnboarding(page);
  const sidebar = page.locator("aside").first();
  const trigger = sidebar.getByTestId("sidebar-search-trigger");
  const search = sidebar.getByRole("textbox", { name: "Search", exact: true });
  await expect(search).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sidebar-search-closed");

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-pressed", "true");
  await expect(search).toBeFocused();
  await captureScreenshot(page, testInfo, "sidebar-search-open");

  // Leaving an empty field keeps the roster still, so a chat click lands.
  const chief = sidebar.getByRole("button", { name: /^Chief/ }).first();
  const before = await chief.boundingBox();
  await chief.click();
  await expect(search).toBeVisible();
  expect((await chief.boundingBox())?.y).toBe(before?.y);

  await search.fill("no roster matches");
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-pressed", "false");

  await trigger.click();
  await expect(search).toHaveValue("");
  await search.fill("kept");
  await trigger.click();
  await expect(search).toHaveCount(0);
});
