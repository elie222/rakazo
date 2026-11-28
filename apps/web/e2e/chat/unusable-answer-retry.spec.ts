import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

// Kept out of run-failure.spec.ts, which pull-request CI skips, so pull requests capture this banner.
test("an unusable answer offers Try again beside Choose a model", async ({ page }, testInfo) => {
  await signup(page, `unusable-answer-${Date.now()}@rakazo.test`, "password12", "Unusable Answer");
  await completeOnboarding(page);
  await page.route("**/rpc/threads/get", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      json?: { run?: { status: string; error: string | null; retryable?: boolean } };
    };
    const run = body.json?.run;
    if (run?.status === "failed") {
      run.error = "Unhandled stop reason: MALFORMED_RESPONSE";
      run.retryable = true;
    }
    await route.fulfill({ response, json: body });
  });

  await page.getByPlaceholder(/^Message /).fill("fail this run");
  await page.getByRole("button", { name: "Send" }).click();
  const error = page.getByTestId("composer-error");
  await expect(error).toContainText("The model returned an unusable response. Try again.", {
    timeout: 30_000,
  });
  const chooseModel = error.getByTestId("composer-error-action");
  await expect(chooseModel).toBeVisible();
  await expect(chooseModel).toHaveText("Choose a model");
  const retry = error.getByTestId("composer-error-retry");
  await expect(retry).toBeVisible();
  await expect(retry).toHaveText("Try again");
  await captureScreenshot(page, testInfo, "unusable-answer-offers-retry-and-model");
});
