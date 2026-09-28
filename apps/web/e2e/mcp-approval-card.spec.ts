import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("keeps the approved MCP card state after the thread remounts", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `mcp-approval-${stamp}@rakazo.test`, "password12", "MCP Approval");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("show an mcp approval card");
  await page.keyboard.press("Enter");

  const card = page.getByTestId("mcp-approval-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText("Fixture MCP");
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "mcp-approval-card");

  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(card.getByText(/Connected/i)).toBeVisible({ timeout: 15_000 });

  // The assignment and the card decision live server-side, so a full remount
  // must render the approved state instead of fresh approval buttons.
  const assignment = await rpc<{ serverId: string }[]>(page, "mcp/assignments/list", { botId });
  expect(assignment.some((row) => row.serverId.length > 0)).toBe(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  const restored = page.getByTestId("mcp-approval-card");
  await expect(restored).toBeVisible({ timeout: 15_000 });
  await expect(restored.getByText(/Connected/i)).toBeVisible();
  await expect(restored.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
});
