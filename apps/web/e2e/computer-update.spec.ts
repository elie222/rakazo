import { expect, test } from "@playwright/test";
import type { ComputerUpdate } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  signup,
} from "./helpers";

test("restarting the computer shows durable background progress and failure retry", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
  await signup(page, `computer-update-${Date.now()}@rakazo.test`, "password12", "Computer Update");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  let updates: ComputerUpdate[] = [];
  const restarting: ComputerUpdate = {
    id: "restart-example",
    botId,
    name: "Chief",
    mode: "team",
    status: "running",
    stage: "restoring",
  };
  let finishRestart: (() => void) | undefined;
  let discardUnsaved: unknown;
  let holdRestart = false;
  await page.route("**/rpc/computer/updates", (route) =>
    route.fulfill({ json: { json: updates } }),
  );
  await page.route("**/rpc/computer/restart", async (route) => {
    discardUnsaved = route.request().postDataJSON()?.json?.discardUnsaved;
    if (holdRestart) {
      await new Promise<void>((resolve) => {
        finishRestart = resolve;
      });
    }
    updates = [restarting];
    return route.fulfill({ json: { json: restarting } });
  });
  await openBotPanelTab(page, "Computer");
  await expect(page.getByTestId("computer-preview")).toBeVisible();
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  const restart = page.getByRole("button", { name: "Restart computer", exact: true });
  await restart.hover();
  await captureScreenshot(page, testInfo, "computer-restart-button");
  holdRestart = true;
  await restart.click();
  await expect(restart).toBeDisabled();
  await expect.poll(() => finishRestart).toBeDefined();
  finishRestart!();
  holdRestart = false;
  const dialog = page.getByTestId("computer-update-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Restarting Team Computer");
  await expect(dialog.locator('[aria-current="step"]')).toHaveText("Restoring your workspace");
  await captureScreenshot(page, testInfo, "computer-update-progress");
  await dialog.getByRole("button", { name: "Continue in Background" }).click();
  await expect(dialog).not.toBeVisible();
  await captureScreenshot(page, testInfo, "computer-update-background");
  await page.reload();
  await page.getByRole("button", { name: /Restarting Team Computer/ }).click();
  await expect(dialog).toBeVisible();
  updates = [{ ...restarting, status: "interrupted" }];
  await expect(
    dialog.getByText("Restart is unavailable until the previous operation has stopped."),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-update-interrupted");
  // Older wire flags cannot expose a server lock-release control in the app.
  updates = [{ ...restarting, status: "interrupted", canReleaseReservation: true }];
  await expect(dialog.getByRole("button", { name: "Release computer", exact: true })).toBeHidden();
  updates = [{ ...restarting, status: "failed" }];
  await expect(dialog.getByRole("heading")).toHaveText("Restart failed");
  await captureScreenshot(page, testInfo, "computer-update-failed");
  await expect(dialog.getByRole("button", { name: "Restart without saving" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(dialog.getByRole("heading")).toHaveText("Restarting Team Computer");
  expect(discardUnsaved).toBe(false);
  updates = [{ ...restarting, status: "failed", stage: "saving" }];
  await expect(dialog.getByRole("heading")).toHaveText("Restart failed");
  await captureScreenshot(page, testInfo, "computer-restart-save-failed");
  await dialog.getByRole("button", { name: "Restart without saving", exact: true }).click();
  const confirmDiscard = page.getByRole("alertdialog");
  await expect(confirmDiscard).toContainText("Changes since the last save are lost.");
  await captureScreenshot(page, testInfo, "computer-restart-discard-confirm");
  await confirmDiscard.getByRole("button", { name: "Restart without saving", exact: true }).click();
  await expect(dialog.getByRole("heading")).toHaveText("Restarting Team Computer");
  expect(discardUnsaved).toBe(true);
  updates = [];
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: /Restarting Team Computer/ })).toHaveCount(0);
});
