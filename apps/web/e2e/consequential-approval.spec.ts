import { expect, type Page, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

test("actions run by default while optional confirmations live in space settings", async ({
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

  const settings = await openUserSettings(page);
  await expect(settings).toHaveAttribute("role", "dialog");
  await expect(settings).toBeFocused();
  await expect(settings.getByText("Advanced", { exact: true })).toBeVisible();
  await expect(settings.getByText("Optional controls most people never need")).toHaveCount(0);
  // Confirmations are per space, so they live in their own section, not General.
  await expect(settings.getByRole("heading", { name: "Action confirmations" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "51-user-settings-general");

  await settings.getByTestId("settings-nav-confirmations").click();
  await expect(settings.getByRole("heading", { name: "Confirmations", exact: true })).toBeVisible();
  await expect(
    settings.getByText(
      "Bots act without asking by default. Add an exception only when you want to review a type of action first.",
    ),
  ).toHaveCount(0);
  await expect(settings.getByText("No exceptions. Actions run automatically.")).toHaveCount(0);
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
  expect(alwaysBox!.y).toBe(allowBox!.y);
  expect(denyBox!.y).toBe(allowBox!.y);
  expect(alwaysBox!.x).toBeGreaterThan(allowBox!.x);
  expect(denyBox!.x).toBeGreaterThan(alwaysBox!.x);
  await captureScreenshot(page, testInfo, "53-action-confirmation-pending");
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 400, height: 900 });
  await expect(allowOnce).toBeVisible();
  await expect(alwaysAllow).toBeVisible();
  await expect(deny).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
  if (viewport) await page.setViewportSize(viewport);

  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.getByTestId("transcript").getByText("Denied", { exact: true })).toHaveClass(
    /text-muted-foreground/,
  );
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
