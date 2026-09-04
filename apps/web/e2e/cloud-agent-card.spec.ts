import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

// Harness pins CLOUD_AGENT_PROVIDER=emulator (see packages/testkit); do not point at a live Cursor key.
// cloud_agent_launch is consequential but runs without a confirmation by default (optional in settings).
test("renders a compact cloud agent card from an emulator launch", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `cloud-agent-${stamp}@rakazo.test`, "password12", "Cloud Agent");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("launch a cloud agent to add a README");
  await page.keyboard.press("Enter");

  const card = page.getByTestId("cloud-agent-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText(/running|finished|Add a README|launching|Cloud agent/i);
  await captureScreenshot(page, testInfo, "cloud-agent-card");

  await expect
    .poll(
      async () => {
        const history = await rpc<{
          messages: Array<{ blocks: Array<{ kind: string; status?: string; title?: string }> }>;
        }>(page, "threads/messages", { botId });
        return history.messages
          .flatMap((message) => message.blocks)
          .some((block) => block.kind === "cloud_agent");
      },
      { timeout: 30_000 },
    )
    .toBe(true);
});
