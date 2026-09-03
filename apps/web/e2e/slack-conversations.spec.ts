import { expect, test } from "@playwright/test";
import type { AppBootstrap, ThreadSnapshot } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("opens a Slack conversation beneath its assigned agent as a read-only transcript", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `slack-conversation-${stamp}@rakazo.test`, "password12", "Slack Owner");
  await page.waitForURL(/\/(app|onboarding)/, { timeout: 20_000 });
  await page.goto("/onboarding");
  await completeOnboarding(page);
  const bootstrap = await rpc<AppBootstrap>(page, "bootstrap", {});
  const bot = bootstrap.bots[0];
  if (!bot) throw new Error("onboarding did not create a bot");

  const conversation = {
    id: "external-slack-1",
    spaceId: bot.spaceId,
    botId: bot.id,
    provider: "slack",
    displayName: "Leadership group",
    participantNames: ["Pat", "Slack Owner", "Chief"],
    teamChatAmbientEnabled: null,
    teamChatRules: null,
    automatedSenderPolicies: {
      "B-GITHUB": { name: "GitHub", mode: "ignore" as const },
    },
    automatedSenders: [{ id: "B-GITHUB", name: "GitHub" }],
    threadId: "external-thread-1",
    preview: "GROUP DM OK",
    unread: false,
    updatedAt: "2026-09-01T12:30:00.000Z",
  };
  const snapshot: ThreadSnapshot = {
    externalConversationId: conversation.id,
    externalProvider: "slack",
    externalDisplayName: conversation.displayName,
    externalParticipantNames: conversation.participantNames,
    threadId: conversation.threadId,
    cursor: 3,
    messages: [
      {
        id: "external-message-1",
        threadId: conversation.threadId,
        seq: 1,
        role: "user",
        speakerName: "Pat",
        blocks: [{ kind: "text", text: "Can Chief confirm the launch date?" }],
        createdAt: "2026-09-01T12:29:00.000Z",
      },
      {
        id: "external-message-2",
        threadId: conversation.threadId,
        seq: 2,
        role: "user",
        speakerName: "Slack Owner",
        blocks: [{ kind: "text", text: "It is still Friday." }],
        createdAt: "2026-09-01T12:29:30.000Z",
      },
      {
        id: "external-message-3",
        threadId: conversation.threadId,
        seq: 3,
        role: "bot",
        botId: bot.id,
        blocks: [{ kind: "text", text: "GROUP DM OK" }],
        createdAt: "2026-09-01T12:30:00.000Z",
      },
    ],
    olderCursor: null,
    run: null,
    activeRuns: [],
  };

  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: AppBootstrap };
    body.json.externalConversations = [conversation];
    body.json.spaces = body.json.spaces.map((space) =>
      space.id === conversation.spaceId
        ? { ...space, externalConversations: [conversation] }
        : space,
    );
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: JSON.stringify(body),
    });
  });
  await page.route("**/rpc/spaces/list", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      json: {
        current: {
          externalConversations: typeof bootstrap.externalConversations;
        };
        spaces: AppBootstrap["spaces"];
      };
    };
    body.json.current.externalConversations = [conversation];
    body.json.spaces = body.json.spaces.map((space) =>
      space.id === conversation.spaceId
        ? { ...space, externalConversations: [conversation] }
        : space,
    );
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: JSON.stringify(body),
    });
  });
  await page.route("**/rpc/threads/get", async (route) => {
    const input = route.request().postDataJSON() as {
      json?: { externalConversationId?: string };
    };
    if (input.json?.externalConversationId !== conversation.id) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ json: snapshot }),
    });
  });
  let savedPolicy: Record<string, unknown> | undefined;
  await page.route("**/rpc/externalConversations/updatePolicy", async (route) => {
    const input = route.request().postDataJSON() as { json: Record<string, unknown> };
    savedPolicy = input.json;
    const { externalConversationId: _, ...policy } = input.json;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ json: policy }),
    });
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  const conversationButton = page.locator(`[data-external-conversation-id="${conversation.id}"]`);
  await expect(conversationButton).toContainText("Leadership group");
  await expect(conversationButton).toContainText("Pat, Slack Owner, Chief");
  await conversationButton.click();
  await expect(page).toHaveURL(new RegExp(`/app/x/${conversation.id}$`));
  await expect(page.getByTestId("transcript")).toContainText("GROUP DM OK");
  await expect(page.getByTestId("transcript")).not.toContainText("U-PAT");
  await expect(page.getByTestId("composer-bar")).toHaveCount(0);

  const responseRow = page
    .getByTestId("transcript")
    .locator('[data-message-id="external-message-3"]');
  await responseRow.hover();
  await expect(responseRow.getByRole("button", { name: "Reply" })).toHaveCount(0);
  await expect(responseRow.getByRole("button", { name: "Copy" })).toBeVisible();
  const speakerMessages = page.getByTestId("external-speaker-message");
  await expect(speakerMessages).toHaveCount(2);
  await expect(speakerMessages.nth(0)).toHaveText("@Pat: Can Chief confirm the launch date?");
  await expect(speakerMessages.nth(1)).toHaveText("@Slack Owner: It is still Friday.");
  await expect(speakerMessages.nth(0)).toHaveCSS("color", "rgb(46, 46, 50)");

  await page.getByTestId("conversation-settings-trigger").click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "external-settings");
  await page.getByRole("button", { name: "Listen", exact: true }).click();
  await page.getByLabel("Room guidance").fill("Engage when a launch owner or date changes.");
  await page.getByLabel("GitHub handling").selectOption("action");
  await page
    .getByTestId("external-conversation-settings")
    .getByRole("button", { name: "Save" })
    .click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(savedPolicy).toEqual({
    externalConversationId: conversation.id,
    teamChatAmbientEnabled: true,
    teamChatRules: "Engage when a launch owner or date changes.",
    automatedSenderPolicies: {
      "B-GITHUB": { name: "GitHub", mode: "action" },
    },
  });
  await captureScreenshot(page, testInfo, "slack-conversation-settings");
  await page.getByRole("button", { name: "Close panel" }).click();
  await captureScreenshot(page, testInfo, "slack-conversation-transcript");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("transcript")).toContainText("GROUP DM OK");
  await expect(page.getByTestId("composer-bar")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "slack-conversation-transcript-mobile");
});
