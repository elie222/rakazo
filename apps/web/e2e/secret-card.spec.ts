import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("renders masked secret card and saves without putting the value in chat", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `secret-card-${stamp}@rakazo.test`, "password12", "Secret Card");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("show a secret card for a masked api key");
  await page.keyboard.press("Enter");

  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("waiting_input");

  // threads/get can observe waiting_input before the shell realtime feed paints the ask card.
  const card = page.getByTestId("secret-ask-card");
  if ((await card.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText("API key", { exact: true }).first()).toBeVisible();
  const secretField = card.getByLabel("API key");
  await expect(secretField).toHaveAttribute("type", "password");
  await expect(card.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "secret-card");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  await expect(secretField).toBeVisible();
  await captureScreenshot(page, testInfo, "secret-card-narrow");

  await page.setViewportSize({ width: 1280, height: 720 });
  const secretValue = `sk-test-secret-${stamp}`;
  await secretField.fill(secretValue);
  await card.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(secretValue)).toHaveCount(0);
  await expect(composer).not.toHaveValue(secretValue);

  await expect
    .poll(
      async () => {
        const history = await rpc<{
          messages: Array<{
            blocks: Array<{
              kind: string;
              status?: string;
              answer?: string;
              input?: string;
              text?: string;
              detail?: string;
            }>;
          }>;
        }>(page, "threads/messages", { botId });
        const answered = history.messages
          .flatMap((message) => message.blocks)
          .find(
            (block) =>
              block.kind === "ask" && block.input === "secret" && block.status === "answered",
          );
        if (!answered) return null;
        const serialized = JSON.stringify(history);
        if (serialized.includes(secretValue)) return "leaked";
        return answered.answer ?? "";
      },
      { timeout: 30_000 },
    )
    .toBe("");

  await captureScreenshot(page, testInfo, "secret-card-saved");
});
