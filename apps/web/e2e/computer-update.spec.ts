import { expect, test } from "@playwright/test";
import type { ComputerUpdate } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, signup } from "./helpers";

test("computer maintenance shows durable background progress and failure recovery", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
  await signup(page, `computer-update-${Date.now()}@rakazo.test`, "password12", "Computer Update");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  let updates: ComputerUpdate[] = [];
  const updating: ComputerUpdate = {
    id: "update-example",
    botId,
    name: "Chief",
    mode: "team",
    action: "update",
    status: "running",
    stage: "restoring",
  };
  await page.route("**/rpc/computer/updates", (route) =>
    route.fulfill({ json: { json: updates } }),
  );
  await page.route("**/rpc/computer/update", (route) => {
    updates = [updating];
    return route.fulfill({ json: { json: updating } });
  });
  await page.route("**/rpc/computer/recover", (route) => {
    updates = [{ ...updating, id: "recovery-example", action: "recover", stage: "preparing" }];
    return route.fulfill({ json: { json: updates[0] } });
  });
  let releases = 0;
  await page.route("**/rpc/computer/releaseInterrupted", (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      json: { id: updating.id, workersStopped: true },
    });
    releases++;
    updates = [{ ...updating, status: "failed" }];
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await page.getByTitle("Agent computer").click();
  await expect(page.getByTestId("computer-preview")).toBeVisible();
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  await page.getByTestId("computer-more-button").click();
  await page.getByRole("menuitem", { name: "Update computer", exact: true }).click();
  const dialog = page.getByTestId("computer-update-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Updating Team Computer");
  await expect(dialog.locator('[aria-current="step"]')).toHaveText("Restoring your workspace");
  await captureScreenshot(page, testInfo, "computer-update-progress");
  await dialog.getByRole("button", { name: "Continue in Background" }).click();
  await expect(dialog).not.toBeVisible();
  await captureScreenshot(page, testInfo, "computer-update-background");
  await page.reload();
  await page.getByRole("button", { name: /Updating Team Computer/ }).click();
  await expect(dialog).toBeVisible();
  updates = [{ ...updating, status: "interrupted" }];
  await expect(
    dialog.getByText("Recovery is unavailable until the previous operation has stopped."),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Recover computer" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-update-interrupted");
  updates = [{ ...updating, status: "interrupted", canReleaseReservation: true }];
  await dialog.getByRole("button", { name: "Release computer", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await captureScreenshot(page, testInfo, "computer-update-release-confirmation");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(releases).toBe(0);
  await dialog.getByRole("button", { name: "Release computer", exact: true }).click();
  await confirmation
    .getByRole("button", { name: "Workers and operations are stopped", exact: true })
    .click();
  await expect(dialog.getByRole("button", { name: "Recover computer", exact: true })).toBeVisible();
  expect(releases).toBe(1);
  await expect(dialog.getByRole("heading")).toHaveText("Update failed");
  await captureScreenshot(page, testInfo, "computer-update-failed");
  await dialog.getByRole("button", { name: "Recover computer" }).click();
  await expect(dialog.getByRole("heading")).toHaveText("Recovering Team Computer");
  await captureScreenshot(page, testInfo, "computer-recovery-progress");
  updates = [];
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: /Recovering Team Computer/ })).toHaveCount(0);
});
