import { expect, test } from "@playwright/test";
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
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  // The bot carries on by itself; the scripted model echoes the turn it was given.
  await expect(
    page.getByTestId("message-bot-bubble").getByText(/i handled: The user just connected "Gmail"/),
  ).toBeVisible({ timeout: 30_000 });
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

test("an app's sign-in finishes in its popup even after the chat tab is gone", async ({
  page,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signup(page, `callback-connect-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId });
  const chat = page.url();
  await page.getByPlaceholder(/Message/).fill("Can you connect to Airtable?");
  await page.keyboard.press("Enter");
  const card = page.getByRole("group", { name: "Airtable connection", exact: true });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await context.route("https://pipedream.example.test/connect**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Fixture provider sign-in</h1>" }),
  );
  const begun = page.waitForResponse("**/rpc/connections/begin");
  const opened = page.waitForEvent("popup");
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  const { json } = (await (await begun).json()) as { json: { connectionId: string } };
  const popup = await opened;
  await expect(popup.getByText("Fixture provider sign-in")).toBeVisible();
  // Connect is ready again at once, so an abandoned sign-in can be started over.
  await expect(card.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
  await captureScreenshot(popup, testInfo, "callback-provider-sign-in");

  // The chat closes before the provider sends the sign-in back to the callback.
  await page.close();
  const closed = popup.waitForEvent("close");
  await popup.goto(`/integrations/callback/${json.connectionId}`);
  await closed;

  const again = await context.newPage();
  await again.setViewportSize({ width: 1280, height: 900 });
  await again.goto(chat);
  const landed = again.getByRole("group", { name: "Airtable connection", exact: true });
  await expect(landed.getByText("Connected", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(
    again
      .getByTestId("message-bot-bubble")
      .getByText(/i handled: The user just connected "Airtable"/),
  ).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(again, testInfo, "callback-connected-after-tab-closed");
});
