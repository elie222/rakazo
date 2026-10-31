import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("connected account quota shows remaining windows and refreshes", async ({
  page,
}, testInfo) => {
  await signup(page, `quota-${Date.now()}@rakazo.test`, "password12", "Quota Preview");
  await completeOnboarding(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const credentialId = "quota-claude-fixture";
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: credentialId,
            provider: "anthropic",
            label: "Work",
            hasKey: true,
            isDefault: false,
            authKind: "oauth",
            modelId: "claude-haiku-5-5",
          },
        ],
      },
    }),
  );
  let usedPercent = 91;
  await page.route("**/rpc/models/quota", (route) =>
    route.fulfill({
      json: {
        json: {
          credentialId,
          status: "fresh",
          observedAt: "2030-03-17T12:00:00.000Z",
          checkedAt: "2030-03-17T12:00:00.000Z",
          windows: [
            {
              id: "five_hour",
              usedPercent: 0,
              resetsAt: "2030-03-17T17:00:00.000Z",
              modelIds: null,
            },
            { id: "seven_day", usedPercent, resetsAt: "2030-03-20T12:00:00.000Z", modelIds: null },
          ],
        },
      },
    }),
  );
  await openUserSettings(page, "usage");
  const quota = page.getByTestId("provider-quota-stack").getByTestId("connection-quota");
  await expect(quota).toBeVisible();
  await expect(quota.locator("h3")).not.toContainText("Work");
  await expect(quota.getByText("Work", { exact: true })).toHaveCount(1);
  await expect(quota).toContainText("9% remaining");
  await expect(quota).toContainText("100% remaining");
  await expect(quota.locator("time").first()).toHaveAttribute(
    "datetime",
    "2030-03-17T17:00:00.000Z",
  );
  await captureScreenshot(page, testInfo, "model-quota-connected-account");
  usedPercent = 100;
  await quota.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(quota).toContainText("0% remaining");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(quota).toBeVisible();
  await expect(page.getByTestId("usage-sort-controls")).toHaveJSProperty(
    "scrollWidth",
    await page.getByTestId("usage-sort-controls").evaluate((element) => element.clientWidth),
  );
  const settings = await page.getByTestId("user-settings").boundingBox();
  expect(settings?.height).toBeLessThan(760);
  await captureScreenshot(page, testInfo, "model-quota-narrow");
  expect(errors).toEqual([]);
});
