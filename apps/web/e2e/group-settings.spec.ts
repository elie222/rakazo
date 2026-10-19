import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openNewGroup,
  signup,
} from "./helpers";

test("group settings shows members first, roster behind Show all", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  await signup(page, `group-settings-${stamp}@rakazo.test`, "password12", "Settings E2E");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await createNamedBot(page, "Researcher");
  await createNamedBot(page, "Research Writer");
  await createNamedBot(page, "Runner");

  await openNewGroup(page);
  await page.locator("label:has-text('Name') input").fill("Settings team");
  const panel = page.getByTestId("side-panel");
  await panel.getByRole("checkbox", { name: "Add Researcher to the group" }).click();
  await panel.getByRole("checkbox", { name: "Add Research Writer to the group" }).click();
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  // Open group settings: members view first, not the full roster.
  await page.getByTestId("bot-settings-trigger").click();
  await expect(panel).toHaveAttribute("data-panel", "group-settings");
  await expect(panel.getByText("Members (2)", { exact: true })).toBeVisible();
  await expect(panel.getByRole("checkbox")).toHaveCount(2);
  await expect(panel.getByLabel("Filter bots")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "group-settings-members");

  // Show all expands the roster and reveals the filter.
  await panel.getByRole("button", { name: "Show all" }).click();
  await expect(panel.getByRole("checkbox")).toHaveCount(4);
  await expect(panel.getByRole("checkbox", { name: "Add Runner to the group" })).toBeVisible();

  // The filter narrows the roster by name.
  await panel.getByLabel("Filter bots").fill("writ");
  await expect(panel.getByRole("checkbox")).toHaveCount(1);
  await panel.getByLabel("Filter bots").fill("zzz");
  await expect(panel.getByText("No bots match")).toBeVisible();
  await panel.getByLabel("Filter bots").fill("");
  await captureScreenshot(page, testInfo, "group-settings-roster");

  // Unchecking keeps the member listed so the mis-click is reversible.
  await panel.getByRole("checkbox", { name: "Remove Research Writer from the group" }).click();
  await panel.getByRole("button", { name: "Show selected" }).click();
  await expect(
    panel.getByRole("checkbox", { name: "Add Research Writer to the group" }),
  ).toBeVisible();
});
