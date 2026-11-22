import { expect, test } from "@playwright/test";
import type { ComputerUpdate } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

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
  // The app re-reads the list only when the live stream signals. With the stream turned away,
  // nothing does, so each change below is shown by opening the page again.
  await page.route("**/rpc/notifications/subscribe", (route) =>
    route.fulfill({
      status: 404,
      json: { json: { defined: false, code: "NOT_FOUND", status: 404, message: "Not found" } },
    }),
  );
  const reopen = async (next: ComputerUpdate[], button: RegExp) => {
    updates = next;
    await page.reload();
    await page.getByRole("button", { name: button }).click();
    await expect(dialog).toBeVisible();
  };
  let recoveryRefused = true;
  await page.route("**/rpc/computer/recover", (route) => {
    if (recoveryRefused)
      return route.fulfill({
        status: 409,
        json: {
          json: {
            defined: false,
            code: "CONFLICT",
            status: 409,
            message: "The computer is still shutting down. Try again after it stops.",
          },
        },
      });
    updates = [{ ...updating, id: "recovery-example", action: "recover", stage: "preparing" }];
    return route.fulfill({ json: { json: updates[0] } });
  });
  const dialog = page.getByTestId("computer-update-dialog");
  // An update started elsewhere, such as from the phone, shows its progress here too.
  await reopen([updating], /Updating Team Computer/);
  await expect(dialog.getByRole("heading")).toHaveText("Updating Team Computer");
  await expect(dialog.locator('[aria-current="step"]')).toHaveText("Restoring your workspace");
  await captureScreenshot(page, testInfo, "computer-update-progress");
  await dialog.getByRole("button", { name: "Continue in Background" }).click();
  await expect(dialog).not.toBeVisible();
  await captureScreenshot(page, testInfo, "computer-update-background");
  await reopen([{ ...updating, status: "interrupted" }], /Update failed/);
  await expect(
    dialog.getByText("Recovery is unavailable until the previous operation has stopped."),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Recover computer" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-update-interrupted");
  // Older wire flags cannot expose a server lock-release control in the app.
  await reopen(
    [{ ...updating, status: "interrupted", canReleaseReservation: true }],
    /Update failed/,
  );
  await expect(dialog.getByRole("button", { name: "Release computer", exact: true })).toBeHidden();
  await reopen([{ ...updating, status: "failed" }], /Update failed/);
  await expect(dialog.getByRole("button", { name: "Recover computer", exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Update failed");
  await captureScreenshot(page, testInfo, "computer-update-failed");
  await dialog.getByRole("button", { name: "Recover computer" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "The computer is still shutting down. Try again after it stops.",
  );
  await captureScreenshot(page, testInfo, "computer-recovery-refused");
  recoveryRefused = false;
  await dialog.getByRole("button", { name: "Recover computer" }).click();
  await expect(dialog.getByRole("heading")).toHaveText("Recovering Team Computer");
  await captureScreenshot(page, testInfo, "computer-recovery-progress");
  updates = [];
  await page.reload();
  // A signalled re-read closing the open dialog is covered by the computer-updates unit tests.
  await expect(page.getByRole("button", { name: /Recovering Team Computer/ })).toHaveCount(0);
});
