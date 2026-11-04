import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("an ongoing call stays in reach on a page outside the shell", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `call-controls-${stamp}@rakazo.test`, "password12", "Call Controls");
  await completeOnboarding(page);
  await rpc(page, "voice/connect", { provider: "scripted", apiKey: "fake-call-voice-key" });
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  // Until the voice status loads, the call button opens voice settings instead of calling.
  const callButton = page.getByTestId("call-button");
  await expect(callButton).toHaveAttribute("data-voice-ready", "");

  await callButton.click();
  const call = page.getByTestId("call-view");
  await expect(call).toBeVisible();

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Artifacts", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/artifacts$/);
  await expect(page.getByRole("heading", { name: "Artifacts", exact: true })).toBeVisible();
  await expect(call).toBeVisible();
  await captureScreenshot(page, testInfo, "call-card-artifacts");

  await call.getByRole("button", { name: "Minimize call" }).click();
  const returnBar = page.getByTestId("call-return-bar");
  await expect(returnBar).toBeVisible();
  await expect(call).toBeHidden();
  await captureScreenshot(page, testInfo, "call-return-bar-artifacts");

  await returnBar.click();
  await expect(call).toBeVisible();
  await call.getByRole("button", { name: "Hang up" }).click();
  await expect(call).toBeHidden();
  await expect(returnBar).toBeHidden();
});

test("a completed live call shows its saved spoken transcript", async ({ page }, testInfo) => {
  await signup(page, `call-transcript-${Date.now()}@rakazo.test`, "password12", "Call Transcript");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = page.url().split("/").at(-1);
  await page.route("**/rpc/threads/get", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const snap = body.json;
    snap.messages.push({
      id: "saved-live-call",
      threadId: snap.threadId,
      seq: snap.cursor + 1,
      role: "bot",
      botId,
      callId: "saved-call",
      blocks: [
        {
          kind: "voice_call",
          callId: "saved-call",
          title: "Planning the day",
          farewell: "Talk soon",
          durationSeconds: 42,
          transcript: [
            { role: "user", text: "Can we plan the day together?" },
            { role: "bot", text: "Of course. What would you like to start with?" },
          ],
        },
      ],
      createdAt: new Date().toISOString(),
    });
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  const card = page.getByTestId("voice-chat-card");
  await card.getByRole("button", { name: /Show transcript/ }).click();
  await expect(card).toContainText("Can we plan the day together?");
  await expect(card).toContainText("Of course. What would you like to start with?");
  await captureScreenshot(page, testInfo, "live-call-saved-transcript");
});
