import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
} from "../helpers/helpers";

test("a message opens a thread beside the chat, and the thread can be marked done", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signup(page, `topic-threads-${Date.now()}@rakazo.test`, "password12", "Thread Tester");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "threads/clear", { botId });
  await page.reload({ waitUntil: "domcontentloaded" });
  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("Plan the launch checklist.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveValue("");
  const parent = transcript
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: "Plan the launch checklist." })
    .first();
  await parent.hover();
  await parent.getByRole("button", { name: "Reply in thread", exact: true }).click();

  const panel = page.getByTestId("thread-panel");
  await expect(panel.getByText("Plan the launch checklist.", { exact: true })).toBeVisible();
  const reply = panel.getByRole("textbox", { name: "Reply in thread" });
  await reply.fill("Start with the press kit.");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(reply).toHaveValue("");
  await expect(
    panel.getByTestId("message-user-bubble").filter({ hasText: "Start with the press kit." }),
  ).toBeVisible();
  await expect(parent.getByTestId("topic-footer")).toContainText(/\d+ repl(y|ies)/);
  await captureScreenshot(page, testInfo, "topic-thread-panel");

  await panel.getByRole("button", { name: "Done", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
  await expect(parent.getByTestId("topic-footer")).toContainText("Done");

  await page.getByTestId("threads-button").click();
  await expect(page.getByRole("heading", { name: "Done", exact: true })).toBeVisible();
  await expect(page.getByTestId("thread-row")).toContainText("Plan the launch checklist.");
  await captureScreenshot(page, testInfo, "topic-threads-list");
});
