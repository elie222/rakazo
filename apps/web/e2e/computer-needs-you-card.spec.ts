import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  realSandboxTimeout,
  rpc,
  signup,
} from "./helpers";

test("needs-you computer card opens the computer", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `needs-you-${stamp}@rakazo.test`, "password12", "Needs You");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("install the gsc cli and sign in");
  await page.keyboard.press("Enter");

  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      {
        timeout: realSandboxTimeout(90_000, 30_000),
        message: "the protected-input run must be ready for takeover",
      },
    )
    .toBe("waiting_takeover");

  const card = page.getByTestId("computer-card");
  if ((await card.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText("Computer", { exact: true })).toBeVisible();
  await expect(card.getByText("Needs you", { exact: true })).toBeVisible();
  const open = card.getByTestId("computer-card-open");
  await expect(open).toBeVisible();
  await expect(open).toHaveText("Open");
  await captureScreenshot(page, testInfo, "computer-needs-you-card");

  await open.click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await expect(page.getByTestId("computer-viewport")).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-needs-you-card-open");
});
