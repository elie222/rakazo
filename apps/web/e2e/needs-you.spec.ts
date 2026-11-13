import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

type RunSnapshot = { run?: { status: string } | null };

async function waitForStatus(page: Page, botId: string, status: string) {
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<RunSnapshot>(page, "threads/get", { botId });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe(status);
}

async function createBot(page: Page, name: string) {
  return rpc<{ id: string }>(page, "bots/create", {
    name,
    title: "",
    description: "",
    notifyOnFinish: true,
  });
}

test("Needs you collects questions, approvals, takeovers and failures, and answers in place", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `needs-you-${stamp}@rakazo.test`, "password12", "Needs You");
  await completeOnboarding(page);

  const questionBot = await createBot(page, "City Scout");
  const approvalBot = await createBot(page, "Page Reader");
  const takeoverBot = await createBot(page, "Sign-in Bot");
  const failedBot = await createBot(page, "Broken Bot");

  await rpc(page, "threads/send", {
    botId: questionBot.id,
    text: "pick from these cities with tappable choices",
  });
  await waitForStatus(page, questionBot.id, "waiting_input");

  await rpc(page, "threads/send", {
    botId: approvalBot.id,
    text: "show a fetch approval card",
  });
  await waitForStatus(page, approvalBot.id, "waiting_input");

  await rpc(page, "threads/send", {
    botId: takeoverBot.id,
    text: "take over the screen",
  });
  await waitForStatus(page, takeoverBot.id, "waiting_takeover");

  await rpc(page, "threads/send", { botId: failedBot.id, text: "fail this run" });
  await waitForStatus(page, failedBot.id, "failed");
  await rpc(page, "threads/markUnread", { botId: failedBot.id });

  await page.reload();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  const needsYou = page.getByTestId("needs-you-trigger");
  await expect(needsYou).toContainText("4", { timeout: 30_000 });
  await captureScreenshot(page, testInfo, "needs-you-sidebar");
  await needsYou.click();

  await expect(page).toHaveURL(/\/app\/needs$/);
  await expect(page.getByRole("heading", { name: "Needs you", exact: true })).toBeVisible();
  await expect(page.getByTestId("attention-item-question")).toContainText(
    "Which city should I use?",
  );
  await expect(page.getByTestId("attention-item-approval")).toContainText(
    "Review before web_fetch",
  );
  const approval = page.getByTestId("attention-item-approval");
  await expect(approval.getByRole("button", { name: /Allow|Always|Deny/ })).toHaveCount(0);
  await expect(approval.getByRole("button", { name: "Open chat" })).toBeVisible();
  await expect(page.getByTestId("attention-item-takeover")).toContainText(
    "Sign-in Bot needs the screen",
  );
  await expect(page.getByTestId("attention-item-failed")).toContainText("fail this run");
  await captureScreenshot(page, testInfo, "needs-you");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("attention-item-question")).toBeVisible();
  await captureScreenshot(page, testInfo, "needs-you-narrow");
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole("button", { name: "Seoul", exact: true }).click();
  await expect(page.getByTestId("attention-item-question")).toHaveCount(0, { timeout: 30_000 });
  await captureScreenshot(page, testInfo, "needs-you-after-answer");
  await approval.getByRole("button", { name: "Open chat" }).click();
  await expect(page).toHaveURL(new RegExp(approvalBot.id));
});
