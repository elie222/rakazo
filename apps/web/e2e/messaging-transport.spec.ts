import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

type ThreadPayload = {
  json?: {
    threadId?: string;
    cursor?: number;
    messages?: unknown[];
    thread?: {
      threadId?: string;
      cursor?: number;
      messages?: unknown[];
    };
  };
};

function injectTransportMessage(body: ThreadPayload, stamp: number) {
  const targets = [body.json, body.json?.thread].filter(Boolean) as Array<{
    threadId?: string;
    cursor?: number;
    messages?: unknown[];
  }>;
  for (const target of targets) {
    if (!Array.isArray(target.messages)) continue;
    const threadId = target.threadId ?? body.json?.threadId ?? body.json?.thread?.threadId ?? "";
    const seq = (target.cursor ?? 0) + 1;
    target.cursor = seq;
    target.messages.push({
      id: `transport-message-${stamp}`,
      threadId,
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
}

test("labels a Sendblue group message with its actual transport", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `messaging-transport-${stamp}@rakazo.test`, "password12", "Transport E2E");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  // Reload hydrates from bootstrap.thread first; threads/get is a second path.
  const fulfillWithInjection = async (route: Parameters<Parameters<typeof page.route>[1]>[0]) => {
    const response = await route.fetch();
    const body = (await response.json()) as ThreadPayload;
    injectTransportMessage(body, stamp);
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: JSON.stringify(body),
    });
  };
  await page.route("**/rpc/bootstrap", fulfillWithInjection);
  await page.route("**/rpc/threads/get", fulfillWithInjection);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("combobox", { name: /^Message/ })).toBeVisible({ timeout: 20_000 });
  const transportMessage = page.getByText("SMS · Alice: Dinner is at seven.");
  await expect(transportMessage).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(page, testInfo, "sendblue-sms-transport");
});
