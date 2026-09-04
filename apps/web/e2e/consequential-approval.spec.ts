import { expect, type Page, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("actions run by default while optional confirmations live in advanced user settings", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `action-confirmations-${stamp}@rakazo.test`, "password12", "Approval UI");
  await completeOnboarding(page, testInfo);

  await sendDestinationWrite(page, "write this to the destination crm as a note");
  await waitForRunIdle(page);
  await expectComposerReady(page);
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "50-actions-run-without-confirmation");

  await page.getByTestId("bot-settings-trigger").click();
  await expect(page.getByTestId("bot-settings")).toBeVisible();
  await expect(page.getByTestId("bot-settings").getByText("Action confirmations")).toHaveCount(0);
  await page.getByRole("button", { name: "Close panel" }).click();

  await openUserSettings(page);
  const settings = page.getByTestId("user-settings");
  await expect(settings).toHaveAttribute("role", "dialog");
  await expect(settings).toBeFocused();
  await expect(settings.getByText("Optional controls most people never need")).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Action confirmations" })).not.toBeVisible();
  await captureScreenshot(page, testInfo, "51-user-settings-advanced-collapsed");

  await settings.getByText("Advanced", { exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Action confirmations" })).toBeVisible();
  await expect(settings.getByText("No exceptions. Actions run automatically.")).toBeVisible();
  await expect(settings.getByTestId("auto-review-toggle")).toBeVisible();
  await expect(settings.getByTestId("auto-review-toggle")).not.toBeChecked();
  await expect(settings.getByText("Flag unexpected actions")).toBeVisible();
  await settings.getByRole("button", { name: "Ask before sending external email" }).click();
  await expect(settings.getByText("Ask before email actions", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "52-advanced-action-confirmations");
  await settings.getByRole("button", { name: "Close user settings" }).click();

  await rpc(page, "approvalRules/set", {
    effect: "require_approval",
    matchKind: "connector",
    matchValue: "destination.write",
  });

  await requestDestinationWrite(page, "write this to the destination crm as a note again");
  const allowOnce = page.getByRole("button", { name: "Allow once", exact: true });
  const alwaysAllow = page.getByRole("button", { name: "Always allow this tool", exact: true });
  const deny = page.getByRole("button", { name: "Deny", exact: true });
  await expect(alwaysAllow).toBeVisible();
  await expect(deny).toBeVisible();
  const allowBox = await allowOnce.boundingBox();
  const alwaysBox = await alwaysAllow.boundingBox();
  const denyBox = await deny.boundingBox();
  expect(allowBox).toBeTruthy();
  expect(alwaysBox).toBeTruthy();
  expect(denyBox).toBeTruthy();
  expect(alwaysBox!.y).toBeGreaterThan(allowBox!.y + allowBox!.height - 2);
  expect(denyBox!.y).toBeGreaterThan(alwaysBox!.y + alwaysBox!.height - 2);
  expect(Math.abs(allowBox!.x - alwaysBox!.x)).toBeLessThan(2);
  const optionList = allowOnce.locator("xpath=ancestor::div[contains(@class,'space-y-1.5')][1]");
  const listBox = await optionList.boundingBox();
  expect(listBox).toBeTruthy();
  expect(Math.abs(allowBox!.width - listBox!.width)).toBeLessThan(2);
  await captureScreenshot(page, testInfo, "53-action-confirmation-pending");

  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.getByText("Denied", { exact: true })).toBeVisible();
  await waitForRunIdle(page);
  await expectComposerReady(page);
  await captureScreenshot(page, testInfo, "54-action-confirmation-denied");

  await requestDestinationWrite(page, "write this to the destination crm once more");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByText("Allowed once", { exact: true })).toBeVisible();
  await waitForRunIdle(page);
  await expectComposerReady(page);
  await captureScreenshot(page, testInfo, "55-action-confirmation-allowed-once");

  await requestDestinationWrite(page, "write this to the destination crm one final time");
  await page.getByRole("button", { name: "Always allow this tool", exact: true }).click();
  await expect(page.getByText("Always allowed", { exact: true })).toBeVisible();
  await waitForRunIdle(page);
  await expectComposerReady(page);
  await captureScreenshot(page, testInfo, "56-action-confirmation-always-allowed");

  await sendDestinationWrite(page, "write this to the destination crm after always allow");
  await waitForRunIdle(page);
  await expectComposerReady(page);
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
});

async function openUserSettings(page: Page) {
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("user-settings")).toBeVisible();
}

async function sendDestinationWrite(page: Page, prompt: string) {
  await expectComposerReady(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill(prompt);
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
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
}

async function requestDestinationWrite(page: Page, prompt: string) {
  await sendDestinationWrite(page, prompt);
  const botId = activeBotId(page);
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 30_000 },
    )
    .toBe("waiting_input");
  // threads/get can observe waiting_input before the shell realtime feed paints the ask card.
  if ((await page.getByRole("button", { name: "Allow once" }).count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible({
    timeout: 15_000,
  });
}

async function waitForRunIdle(page: Page) {
  const botId = activeBotId(page);
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 30_000 },
    )
    .toBeNull();
}
