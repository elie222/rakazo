import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("hides peer exchange in transcript and shows it in Bot messages", async ({
  page,
}, testInfo) => {
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
  await expect(transcript.getByText("Messaged Researcher")).toHaveCount(0);
  await expect(transcript.getByText("Message from Researcher")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "hidden-peer-transcript");

  await page.getByRole("button", { name: "Bot messages" }).click();
  const dialog = page.getByRole("dialog", { name: "Bot messages" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("peer-exchange-alpha").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(dialog.getByText("Researcher").first()).toBeVisible();
  await expect(dialog.getByText("Loading bot messages")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "bot-messages");
});
