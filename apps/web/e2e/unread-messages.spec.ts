import { expect, test } from "@playwright/test";
import type { ThreadSnapshot } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("an unread chat opens at New messages", async ({ page }, testInfo) => {
  await signup(page, `unread-${Date.now()}@rakazo.test`, "password12", "Unread Tester");
  await completeOnboarding(page);
  const homeBotId = activeBotId(page);
  const bot = await rpc<{ id: string }>(page, "bots/create", {
    name: "Notes",
    title: "",
    description: "",
    computerMode: "team",
  });
  const send = async (text: string) => {
    await rpc(page, "threads/send", { botId: bot.id, text });
    await expect
      .poll(async () => {
        const snapshot = await rpc<ThreadSnapshot>(page, "threads/get", { botId: bot.id });
        return snapshot.run === null && snapshot.messages.at(-1)?.role === "bot";
      })
      .toBe(true);
  };
  await send("Remember the first note.");
  await send(
    Array.from({ length: 45 }, (_, index) => `Detail ${index + 1}: keep this for later.`).join(
      "\n",
    ),
  );

  await page.goto(`/app/${bot.id}`);
  const divider = page.getByTestId("unread-separator");
  await expect(divider).toHaveText("New messages");
  await expect(divider).toBeInViewport();
  await captureScreenshot(page, testInfo, "chat-unread-divider");

  // Opening the chat read it, so the next visit has no divider.
  await page.goto(`/app/${homeBotId}`);
  await page.goto(`/app/${bot.id}`);
  await expect(page.getByTestId("transcript")).toContainText("Detail 45");
  await expect(divider).toHaveCount(0);
});
