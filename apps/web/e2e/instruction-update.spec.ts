import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("instruction proposals support edit, approval, undo and opt-in self updates", async ({
  page,
}, testInfo) => {
  await signup(page, `instruction-update-${Date.now()}@rakazo.test`, "password12", "Instructions");
  await completeOnboarding(page);
  const botId = await activeBotId(page);
  const original = (await rpc<{ instructions: string }>(page, "bots/get", { botId })).instructions;
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("propose an instruction update");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Update instructions?", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const proposal = page.getByTestId("instruction-approval-card");
  await expect(proposal.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
  expect((await rpc<{ instructions: string }>(page, "bots/get", { botId })).instructions).toBe(
    original,
  );
  await captureScreenshot(page, testInfo, "instructions-proposal-diff");
  await proposal.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Instructions", exact: true })
    .fill("Never send. Draft only.");
  await proposal.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect((await rpc<{ instructions: string }>(page, "bots/get", { botId })).instructions).toBe(
    "Never send. Draft only.",
  );
  await captureScreenshot(page, testInfo, "instructions-updated-undo");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restored", exact: true })).toBeVisible();
  expect((await rpc<{ instructions: string }>(page, "bots/get", { botId })).instructions).toBe(
    original,
  );
  await rpc(page, "bots/update", { botId, selfUpdateInstructions: true });
  await composer.fill("propose an instruction update");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect((await rpc<{ instructions: string }>(page, "bots/get", { botId })).instructions).toBe(
    "Draft only. Ask before sending.",
  );
  await page.getByTestId("bot-settings-trigger").click();
  await page.getByTestId("bot-settings-advanced").getByText("Advanced", { exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Let this bot update its own instructions" }),
  ).toBeChecked();
  await expect(page.getByText("Instruction history", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "instruction-settings-history");
});
