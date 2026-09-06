import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("labels a Sendblue group message with its actual transport", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `messaging-transport-${stamp}@rakazo.test`, "password12", "Transport E2E");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await page.route("**/rpc/threads/get", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      json?: { threadId: string; cursor: number; messages: unknown[] };
    };
    if (body.json) {
      const seq = body.json.cursor + 1;
      body.json.cursor = seq;
      body.json.messages.push({
        id: `transport-message-${stamp}`,
        threadId: body.json.threadId,
        seq,
        role: "system",
        blocks: [
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "SMS",
            channelId: `transport-channel-${stamp}`,
            fromAddress: "+15551234567",
            fromLabel: "Alice",
            text: "Dinner is at seven.",
          },
        ],
        createdAt: new Date().toISOString(),
      });
    }
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: JSON.stringify(body),
    });
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  const transportMessage = page.getByText("SMS · Alice: Dinner is at seven.");
  await expect(transportMessage).toBeVisible();
  await captureScreenshot(page, testInfo, "sendblue-sms-transport");
});
