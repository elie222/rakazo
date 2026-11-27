import { expect, test } from "@playwright/test";
import type { ThreadSnapshot } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "../helpers/helpers";

test("a bot connects an app inline in a normal chat", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signup(page, `inline-connect-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId });
  await page.getByPlaceholder(/Message/).fill("Can you check my Gmail inbox?");
  await page.keyboard.press("Enter");
  const card = page.getByRole("group", { name: "Gmail connection", exact: true });
  await expect(card).toBeVisible();
  await expect(
    page
      .getByTestId("message-bot-bubble")
      .getByText("Connect Gmail and I’ll check your inbox.", { exact: true }),
  ).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await captureScreenshot(page, testInfo, `web-pending-${theme}`);
  }
  const before = await rpc<ThreadSnapshot>(page, "threads/get", { botId });
  const originRun = before.messages.find((message) =>
    message.blocks.some((block) => block.kind === "app_connect" && block.status === "pending"),
  )?.runId;
  expect(originRun).toBeTruthy();
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  const beforeIds = new Set(before.messages.map((message) => message.id));
  await expect
    .poll(async () => {
      const after = await rpc<ThreadSnapshot>(page, "threads/get", { botId });
      return after.messages.some(
        (message) =>
          !beforeIds.has(message.id) &&
          message.role === "bot" &&
          message.runId &&
          message.runId !== originRun &&
          message.blocks.some((block) => block.kind === "text"),
      );
    })
    .toBe(true);
  await page.reload();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await captureScreenshot(page, testInfo, `web-connected-${theme}`);
  }
});

test("a group card authorizes in its own thread without duplicate pending cards", async ({
  page,
}, testInfo) => {
  await signup(page, `group-connect-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  const firstBotId = activeBotId(page);
  const peerId = await createNamedBot(page, "Assistant");
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Team",
    botIds: [firstBotId, peerId],
  });
  await page.goto(`/app/g/${group.id}`);
  await page.getByRole("combobox", { name: "Message Team" }).fill("Can you check my Gmail inbox?");
  await page.keyboard.press("Enter");
  const card = page.getByRole("group", { name: "Gmail connection", exact: true });
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "group-app-connect-pending");
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await page.reload();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "group-app-connect-connected");
});
