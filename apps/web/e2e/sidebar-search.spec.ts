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
  const originalSearch = (await search.elementHandle())!;
  // These synthetic keyboard events exercise the browser event flags; they do not start an OS IME.
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    await search.dispatchEvent("keydown", { key: "Escape", ...composition });
    await expect(search).toBeVisible();
    expect(await originalSearch.evaluate((element) => element.isConnected)).toBe(true);
    await expect(search).toHaveValue("no roster matches");
  }
  await captureScreenshot(page, testInfo, "sidebar-search-composing-escape");
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-pressed", "false");

  await trigger.click();
  await expect(search).toHaveValue("");
  await search.fill("kept");
  await trigger.click();
  await expect(search).toHaveCount(0);

  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const runSearch = sidebar.getByRole("textbox", { name: "Search runs", exact: true });
  await runSearch.fill("kept activity search");
  const originalRunSearch = (await runSearch.elementHandle())!;
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    await runSearch.dispatchEvent("keydown", { key: "Escape", ...composition });
    await expect(runSearch).toBeVisible();
    expect(await originalRunSearch.evaluate((element) => element.isConnected)).toBe(true);
    await expect(runSearch).toHaveValue("kept activity search");
  }
  await runSearch.press("Escape");
  await expect(runSearch).toBeVisible();
  await expect(runSearch).toHaveValue("");
});
