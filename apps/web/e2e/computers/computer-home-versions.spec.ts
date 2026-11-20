import { expect, test } from "@playwright/test";
import { deferred } from "@rakazo/core/test-async";
import { captureScreenshot, completeOnboarding, openBotSettings, signup } from "../helpers/helpers";

test("a failed saved-files read offers Retry and restores once it works", async ({
  page,
}, testInfo) => {
  await signup(page, `computer-files-${Date.now()}@rakazo.test`, "password12", "Computer Files");
  await completeOnboarding(page);

  // A 502 is what the proxy answers while object storage is down.
  let storageDown = true;
  const reading = deferred<void>();
  await page.route("**/rpc/computer/homeVersions", async (route) => {
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

  storageDown = false;
  await retry.click();
  await expect(retry).toBeDisabled();
  reading.resolve();

  await expect(
    settings.getByRole("button", { name: "Restore earlier version", exact: true }),
  ).toBeVisible();
  await expect(settings.getByRole("alert")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-files-restored");
});
