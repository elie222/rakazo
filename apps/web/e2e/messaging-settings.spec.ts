import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

/**
 * The messaging surface is env-gated off in E2E (no platform credentials),
 * so the surface RPCs are fulfilled with fixture data. The screen itself —
 * navigation from account settings, layout, and both action lists — renders
 * exactly as it would against a live deployment.
 */
test("messaging settings show linked chat apps, channels, and connections", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/messaging/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          enabled: true,
          providers: ["sendblue", "slack", "whatsapp", "telegram"],
          openSignup: false,
          identities: [
            {
              id: "mi-1",
              provider: "sendblue",
              address: "+15551230001",
              botId: "bot-1",
              botName: "Chief",
            },
          ],
        },
      }),
    }),
  );
  await page.route("**/rpc/messaging/link/start", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: { code: "ABCD-2345", expiresAt: new Date(Date.now() + 600_000).toISOString() },
      }),
    }),
  );
  await page.route("**/rpc/messaging/channels/list", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: [
          {
            id: "cm1",
            channelId: "ch1",
            identityId: "mi-1",
            provider: "sendblue",
            name: "Family",
            status: "invited",
            memberCount: 3,
          },
        ],
      }),
    }),
  );
  await page.route("**/rpc/messaging/connections/list", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: [
          {
            id: "cn1",
            peerBotName: "Assistant",
            peerOwnerLabel: "Dana",
            status: "pending",
            incoming: true,
          },
        ],
      }),
    }),
  );

  const stamp = Date.now();
  const userName = `Messenger ${stamp}`;
  await signup(page, `messaging-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Messaging" })).toBeVisible();
  await page.getByRole("button", { name: "Manage messaging settings" }).click();

  await expect(page.getByTestId("messaging-settings")).toBeVisible();
  await expect(page.getByText("iMessage · Slack · WhatsApp · Telegram")).toBeVisible();
  await expect(page.getByText("iMessage · +15551230001")).toBeVisible();
  await expect(page.getByText("→ Chief")).toBeVisible();
  await expect(page.getByRole("button", { name: "Unlink" })).toBeVisible();
  await expect(page.getByText("Family")).toBeVisible();
  await expect(page.getByText("Dana's Assistant")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(2);

  // Linking flow: pick a bot, request a code, read it back.
  await page.getByLabel("Bot to link").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Link a chat app" }).click();
  await expect(page.getByTestId("messaging-link-code")).toContainText("ABCD-2345");
  await captureScreenshot(page, testInfo, "messaging-settings");

  await page.getByRole("button", { name: "Close messaging settings" }).click();
  await expect(page.getByTestId("messaging-settings")).toHaveCount(0);
});
