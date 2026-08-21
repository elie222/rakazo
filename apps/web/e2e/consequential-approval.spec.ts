import { expect, type Page, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("actions run by default while optional confirmations live in advanced user settings", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `action-confirmations-${stamp}@rakazo.test`, "password12", "Approval UI");
  await completeOnboarding(page, ["A bit of everything", "Clear and tight"]);

  await sendDestinationWrite(page);
  await waitForRunCompletion(page);
  await expectComposerReady(page);
  await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "50-actions-run-without-confirmation");

  await page.getByTestId("bot-settings-trigger").click();
  await expect(page.getByTestId("bot-settings")).toBeVisible();
  await expect(page.getByTestId("bot-settings").getByText("Action confirmations")).toHaveCount(0);
  await page.getByRole("button", { name: "Close panel" }).click();

  await openUserSettings(page);
  const settings = page.getByTestId("user-settings");
  await expect(settings.getByText("Optional controls most people never need")).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Action confirmations" })).not.toBeVisible();
  await captureScreenshot(page, testInfo, "51-user-settings-advanced-collapsed");

  await settings.getByText("Advanced", { exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Action confirmations" })).toBeVisible();
  await expect(settings.getByText("No exceptions. Actions run automatically.")).toBeVisible();
  await settings.getByRole("button", { name: "Ask before sending external email" }).click();
  await expect(settings.getByText("Ask before email actions", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "52-advanced-action-confirmations");
  await settings.getByRole("button", { name: "Close user settings" }).click();

  await rpc(page, "approvalRules/set", {
    effect: "require_approval",
    matchKind: "connector",
    matchValue: "destination.write",
  });

  await requestDestinationWrite(page);
  await expect(page.getByRole("button", { name: "Always allow this tool" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
  await captureScreenshot(page, testInfo, "53-action-confirmation-pending");

  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText("Denied", { exact: true })).toBeVisible();
  await expectComposerReady(page);
  await captureScreenshot(page, testInfo, "54-action-confirmation-denied");

  await requestDestinationWrite(page);
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText("Allowed once", { exact: true })).toBeVisible();
  await expectComposerReady(page);
  await captureScreenshot(page, testInfo, "55-action-confirmation-allowed-once");

  await requestDestinationWrite(page);
  await page.getByRole("button", { name: "Always allow this tool" }).click();
  await expect(page.getByText("Always allowed", { exact: true })).toBeVisible();
  await expectComposerReady(page);
  await captureScreenshot(page, testInfo, "56-action-confirmation-always-allowed");

  await sendDestinationWrite(page);
  await waitForRunCompletion(page);
  await expectComposerReady(page);
  await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);
});

async function openUserSettings(page: Page) {
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("user-settings")).toBeVisible();
}

async function sendDestinationWrite(page: Page) {
  await expectComposerReady(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("write this to the destination crm as a note");
  const sent = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/send") && response.ok(),
  );
  await page.keyboard.press("Enter");
  await sent;
}

async function expectComposerReady(page: Page) {
  const composer = page.getByPlaceholder(/Message/);
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();
}

async function requestDestinationWrite(page: Page) {
  await sendDestinationWrite(page);
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible({
    timeout: 30_000,
  });
}

async function waitForRunCompletion(page: Page) {
  const botId = activeBotId(page);
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? "completed";
      },
      { timeout: 30_000 },
    )
    .toMatch(/completed|failed|cancelled/);
}
