import { expect, test } from "@playwright/test";
import { deferred } from "@rakazo/core/test-async";
import { captureScreenshot, completeOnboarding, openBotSettings, signup } from "../helpers/helpers";

test("a failed saved-files read offers Retry and restores once it works", async ({
  page,
}, testInfo) => {
  await signup(page, `computer-files-${Date.now()}@rakazo.test`, "password12", "Computer Files");
  await completeOnboarding(page);

  // Simulate a temporary failed read.
  let storageDown = true;
  let holdRetry = false;
  let reads = 0;
  const failedRetry = deferred<void>();
  const reading = deferred<void>();
  await page.route("**/rpc/computer/homeVersions", async (route) => {
    reads += 1;
    if (holdRetry) await failedRetry.promise;
    if (storageDown) {
      await route.fulfill({ status: 502 });
      return;
    }
    // Holds the retry open so the test can see Retry disabled while it runs.
    await reading.promise;
    await route.fulfill({
      json: { json: [{ id: "rev-1", savedAt: "2026-11-19T10:00:00.000Z" }] },
    });
  });
  await openBotSettings(page);

  const settings = page.getByTestId("bot-settings-advanced");
  const retry = settings.getByRole("button", { name: "Retry", exact: true });
  await expect(settings.getByRole("alert")).toHaveText("Could not load");
  await expect(retry).toBeEnabled();
  await captureScreenshot(page, testInfo, "computer-files-load-failed");

  holdRetry = true;
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(retry).toBeDisabled();
  await expect(retry).toBeFocused();
  await expect(settings.getByRole("alert")).toBeEmpty();
  const pendingReads = reads;
  await page.keyboard.press("Enter");
  await expect(retry).toBeFocused();
  expect(reads).toBe(pendingReads);
  failedRetry.resolve();
  await expect(settings.getByRole("alert")).toHaveText("Could not load");
  await expect(retry).toBeEnabled();
  await expect(retry).toBeFocused();

  holdRetry = false;
  storageDown = false;
  await page.keyboard.press("Enter");
  await expect(retry).toBeDisabled();
  reading.resolve();

  await expect(
    settings.getByRole("button", { name: "Restore earlier version", exact: true }),
  ).toBeVisible();
  await expect(settings.getByRole("alert")).toBeEmpty();
  await captureScreenshot(page, testInfo, "computer-files-restored");
});
