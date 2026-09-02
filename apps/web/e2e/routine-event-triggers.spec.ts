import { expect, type Page, test } from "@playwright/test";
import type { Routine } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function openNewRoutineEditor(page: Page) {
  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "New routine" }).click();
  await expect(page.getByRole("button", { name: "Add trigger" })).toBeVisible();
}

test("routine editor event triggers: webhook, git, and slack", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(
    page,
    `routine-events-${stamp}@rakazo.test`,
    "password12",
    "Routine Events",
    testInfo,
  );
  await completeOnboarding(page, testInfo);
  const botId = activeBotId(page);

  await openNewRoutineEditor(page);

  await page.getByPlaceholder("Name this routine").fill("PR triage");
  await page
    .getByPlaceholder("What should this routine do each time it runs?")
    .fill("Summarize the event and open a follow-up.");

  await page.getByRole("button", { name: "Add trigger" }).click();
  await expect(page.getByRole("menuitem", { name: "Teams message" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Linear issue" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Webhook" }).click();
  await expect(page.getByText("When a webhook fires")).toBeVisible();

  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "Git event" }).click();
  await page.getByPlaceholder("owner/repo").fill("acme/app");
  await page.getByRole("button", { name: "PR opened", exact: true }).click();
  await expect(page.getByText("Needs Bearer. GitHub.com hooks cannot send it.")).toBeVisible();

  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "Slack message" }).click();
  await page.getByPlaceholder("@user or id").fill("@alerts");

  await captureScreenshot(page, testInfo, "routine-event-triggers");

  const saved = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/create") && response.ok(),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await saved;

  const routines = await rpc<Routine[]>(page, "routines/list", { botId });
  const created = routines.find((routine) => routine.name === "PR triage");
  expect(created).toBeTruthy();
  expect(created?.eventTriggers.length).toBeGreaterThanOrEqual(3);
});
