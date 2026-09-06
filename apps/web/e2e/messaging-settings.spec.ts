import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

/**
 * The messaging surface is env-gated off in E2E (no platform credentials),
 * so the surface RPCs are fulfilled with fixture data. The screen itself —
 * navigation from account settings, layout, and both action lists — renders
 * exactly as it would against a live deployment.
 */
test("Korean messaging settings show linked chat apps, channels, and connections", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/messaging/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          enabled: true,
          providers: ["sendblue", "slack", "whatsapp", "telegram", "lark"],
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
  const settings = page.getByTestId("user-settings");
  await settings.getByTestId("ui-locale-select").click();
  await settings.getByRole("option", { name: "한국어", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "메시징", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "메시징 설정 관리" }).click();

  await expect(page.getByTestId("messaging-settings")).toBeVisible();
  await expect(page.getByText("iMessage · Slack · WhatsApp · Telegram · Feishu")).toBeVisible();
  await expect(page.getByText("iMessage · +15551230001")).toBeVisible();
  await expect(page.getByText("→ Chief")).toBeVisible();
  await expect(page.getByRole("button", { name: "연결 해제" })).toBeVisible();
  await expect(page.getByText("Family")).toBeVisible();
  await expect(page.getByText("Dana's Assistant")).toBeVisible();
  await expect(page.getByRole("button", { name: "승인" })).toHaveCount(2);

  // Linking flow: pick a bot, request a code, read it back.
  await page.getByLabel("연결할 Bot").selectOption({ index: 1 });
  await page.getByRole("button", { name: "채팅 앱 연결" }).click();
  await expect(page.getByTestId("messaging-link-code")).toContainText(
    "채팅 앱에서 연결할 회선으로 ABCD-2345를 보내세요.",
  );
  await captureScreenshot(page, testInfo, "messaging-settings-ko");

  await page.getByRole("button", { name: "메시징 설정 닫기" }).click();
  await expect(page.getByTestId("messaging-settings")).toHaveCount(0);
});

test("team conversation settings open from messaging overlay", async ({ page }, testInfo) => {
  await page.route("**/rpc/messaging/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          enabled: true,
          providers: ["sendblue", "slack", "whatsapp", "telegram", "lark"],
          openSignup: false,
          identities: [],
        },
      }),
    }),
  );
  await page.route("**/rpc/messaging/channels/list", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: [] }),
    }),
  );
  await page.route("**/rpc/messaging/connections/list", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: [] }),
    }),
  );
  await page.route("**/rpc/externalConversations/updatePolicy", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          teamChatAmbientEnabled: true,
          teamChatRules: "Reply when asked about launch.",
          automatedSenderPolicies: {
            B_GITHUB: { name: "GitHub", mode: "rollup", rollupHours: 6 },
          },
        },
      }),
    }),
  );

  await page.route("**/rpc/spaces/list", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as {
      json?: {
        current?: {
          id: string;
          bots: Array<{ id: string }>;
          externalConversations?: unknown[];
        };
        spaces?: Array<{ id: string; externalConversations?: unknown[] }>;
      };
    };
    const current = payload.json?.current;
    const botId = current?.bots[0]?.id;
    if (current && botId) {
      const conversation = {
        id: "clexternal000000000000001",
        spaceId: current.id,
        botId,
        provider: "slack",
        displayName: "#launch",
        participantNames: ["Ada", "Grace"],
        teamChatAmbientEnabled: null,
        teamChatRules: null,
        automatedSenderPolicies: {
          B_GITHUB: { name: "GitHub", mode: "ignore" },
        },
        automatedSenders: [{ id: "B_GITHUB", name: "GitHub" }],
        threadId: "clthread00000000000000001",
        preview: "Ship Friday?",
        unread: false,
        updatedAt: new Date().toISOString(),
      };
      current.externalConversations = [conversation];
      for (const space of payload.json?.spaces ?? []) {
        if (space.id === current.id) space.externalConversations = [conversation];
      }
    }
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  const stamp = Date.now();
  const userName = `TeamChat ${stamp}`;
  await signup(page, `team-chat-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByTestId("user-settings").getByRole("heading", { name: "Messaging" })).toBeVisible();
  await page.getByRole("button", { name: "Manage messaging settings" }).click();

  await expect(page.getByTestId("messaging-settings")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Team conversations" })).toBeVisible();
  await expect(page.getByText("#launch")).toBeVisible();
  await expect(page.getByText("Slack")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("external-conversation-settings")).toBeVisible();
  await expect(page.getByText("Listening")).toBeVisible();
  await expect(page.getByText("Room guidance")).toBeVisible();
  await expect(page.getByText("GitHub")).toBeVisible();
  await captureScreenshot(page, testInfo, "messaging-team-conversation-settings");
});
