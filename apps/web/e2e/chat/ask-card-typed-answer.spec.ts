import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
} from "../helpers/helpers";

test("an option card lets the person type their own answer and records it as their message", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ask-typed-${stamp}@rakazo.test`, "password12", "Typed Answer");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("pick from these cities with tappable choices");
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
  const prompt = page.locator("p").filter({ hasText: /^Which city should I use\?$/ });
  if ((await prompt.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(prompt).toBeVisible({ timeout: 15_000 });

  const card = page.getByTestId("question-card").last();
  const typeAnswer = card.getByRole("button", { name: "Type your answer", exact: true });
  await expect(typeAnswer).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "ask-card-type-answer-link");

  await typeAnswer.click();
  const input = card.getByRole("textbox", { name: "Answer", exact: true });
  await expect(input).toBeVisible();
  await input.fill("Reykjavik instead");
  await captureScreenshot(page, testInfo, "ask-card-typed-answer-form");

  await card.getByRole("button", { name: "Send answer", exact: true }).click();

  await expect(
    page.getByTestId("message-user-bubble").filter({ hasText: /^Reykjavik instead$/ }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(card).toHaveClass(/opacity-50/);
  await expect(card).not.toContainText("Reykjavik instead");
  await expect(typeAnswer).toBeHidden();
  for (const name of ["Berlin", "Seoul", "Toronto", "Lisbon"]) {
    const option = card.getByRole("button", { name, exact: true });
    await expect(option).toBeDisabled();
    await expect(option).not.toHaveAttribute("aria-pressed", "true");
  }

  await expect
    .poll(
      async () => {
        const history = await rpc<{
          messages: Array<{
            id: string;
            role: string;
            blocks: Array<{
              kind: string;
              text?: string;
              status?: string;
              answer?: string;
              answerMessageId?: string;
              actions?: Array<{ id: string; label: string }>;
            }>;
          }>;
        }>(page, "threads/messages", { botId });
        const userMessage = history.messages.find(
          (message) =>
            message.role === "user" &&
            message.blocks.some(
              (block) => block.kind === "text" && block.text === "Reykjavik instead",
            ),
        );
        const answered = history.messages
          .flatMap((message) => message.blocks)
          .find(
            (block) =>
              block.kind === "ask" &&
              block.status === "answered" &&
              block.answer === "Reykjavik instead",
          );
        return Boolean(userMessage && answered && answered.answerMessageId === userMessage.id);
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  await card.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "ask-card-typed-answer-recorded");
});
