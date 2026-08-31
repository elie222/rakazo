import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("shows peer chips in transcript and opens view-only peer chat", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `peer-msg-${stamp}@rakazo.test`, "password12", "Peer Msg");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chiefId = activeBotId(page);
  await rpc(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message Chief" })).toBeVisible();

  const composer = page.getByRole("textbox", { name: "Message Chief" });
  await composer.fill("message the bot named Researcher saying peer-exchange-alpha");
  await composer.press("Enter");
  await expect(page.getByText("messaging that bot now.").first()).toBeVisible({
    timeout: 60_000,
  });

  await expect
    .poll(
      async () => {
        const history = await rpc<{
          messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
        }>(page, "threads/messages", { botId: chiefId, includePeerRuns: true });
        const peerTexts = history.messages.flatMap((message) =>
          message.blocks
            .filter(
              (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
            )
            .map((block) => block.text ?? ""),
        );
        return peerTexts.some((text) => text.includes("peer-exchange-alpha"));
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  const transcript = page.getByTestId("transcript");
  const chip = transcript
    .getByTestId("peer-receipt-chip")
    .filter({ hasText: "Researcher" })
    .first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip.getByText(/Messaged|Message from/)).toBeVisible();
  // User bubble still contains the phrase; peer body must not appear outside the chip.
  await expect(chip).not.toContainText("peer-exchange-alpha");
  await expect(transcript.getByText("peer-exchange-alpha")).toHaveCount(1);
  await captureScreenshot(page, testInfo, "peer-chip-in-thread");

  await chip.getByRole("button", { name: /Messaged Researcher|Message from Researcher/ }).click();
  const view = page.getByTestId("peer-conversation-view");
  await expect(view).toBeVisible();
  await expect(view.getByRole("heading", { name: /Chief · Researcher/ })).toBeVisible();
  await expect(view.getByText("This chat is view-only")).toBeVisible();
  await expect(view.getByText("peer-exchange-alpha").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(view.getByRole("textbox")).toHaveCount(0);
  await expect(view.getByText("Loading")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "peer-view-only");
});
