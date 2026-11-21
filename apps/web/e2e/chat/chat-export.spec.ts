import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
} from "../helpers/helpers";

test("a chat's menu exports the conversation as a Markdown file", async ({ page }, testInfo) => {
  await signup(page, `chat-export-${Date.now()}@rakazo.test`, "password12", "Export User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = activeBotId(page);
  await rpc(page, "threads/send", {
    botId,
    text: "Plan the launch for Friday",
    clientNonce: `export-${Date.now()}`,
  });

  const sidebar = page.locator("aside").first();
  await sidebar.getByRole("button", { name: /^Chief/ }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Export chat", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "chat-context-menu-export");

  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export chat", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("chief-chat.md");
  const markdown = await readFile((await file.path())!, "utf8");
  expect(markdown).toMatch(/^# Chief\n/);
  expect(markdown).toContain("Plan the launch for Friday");
});
