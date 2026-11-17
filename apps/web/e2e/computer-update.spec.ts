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
  // The mocked list never signals a change, so the app polls it as it does without live signals.
  await page.route("**/rpc/notifications/subscribe", (route) =>
    route.fulfill({
      status: 404,
      json: { json: { defined: false, code: "NOT_FOUND", status: 404, message: "Not found" } },
    }),
  );
  await page.route("**/rpc/computer/recover", (route) => {
    updates = [{ ...updating, id: "recovery-example", action: "recover", stage: "preparing" }];
    return route.fulfill({ json: { json: updates[0] } });
  });
  // An update started elsewhere, such as from the phone, shows its progress here too.
  updates = [updating];
  await page.reload();
  const dialog = page.getByTestId("computer-update-dialog");
  await page.getByRole("button", { name: /Updating Team Computer/ }).click();
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
  // Older wire flags cannot expose a server lock-release control in the app.
  updates = [{ ...updating, status: "interrupted", canReleaseReservation: true }];
  await expect(dialog.getByRole("button", { name: "Release computer", exact: true })).toBeHidden();
  updates = [{ ...updating, status: "failed" }];
  await expect(dialog.getByRole("button", { name: "Recover computer", exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Update failed");
  await captureScreenshot(page, testInfo, "computer-update-failed");
  await dialog.getByRole("button", { name: "Recover computer" }).click();
  await expect(dialog.getByRole("heading")).toHaveText("Recovering Team Computer");
  await captureScreenshot(page, testInfo, "computer-recovery-progress");
  updates = [];
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: /Recovering Team Computer/ })).toHaveCount(0);
});
