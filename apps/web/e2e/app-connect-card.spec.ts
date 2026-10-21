import { expect, test } from "@playwright/test";
import { appConnectCard } from "@rakazo/core";
import { activeBotId, captureScreenshot, completeOnboarding, signup } from "./helpers";

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

test("shows a mid-chat app connection at the question card width", async ({ page }, testInfo) => {
  await signup(page, `app-card-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  let name = "Google Drive";
  let connected = false;
  await page.route(/\/rpc\/(bootstrap|threads\/get)$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const bootstrap = route.request().url().endsWith("/bootstrap");
    const snapshot = bootstrap ? body.json.thread : body.json;
    if (!snapshot) return route.fulfill({ response });
    const card = appConnectCard({
      connectorId: "composio",
      slug: name.startsWith("Gmail") ? "gmail" : "googledrive",
      name,
      logo: null,
      connected,
      noAuth: false,
    });
    const messages = [
      { role: "user", blocks: [{ kind: "text", text: "Can you connect my Google Drive?" }] },
      { role: "bot", blocks: [{ kind: "text", text: "Sure, authorize Google Drive below." }] },
      { role: "bot", blocks: [card] },
    ].map((message, index) => ({
      ...message,
      id: `app-card-${index}`,
      threadId: snapshot.threadId,
      botId: message.role === "bot" ? botId : null,
      runId: null,
      seq: index + 1,
      createdAt: new Date().toISOString(),
    }));
    const seeded = { ...snapshot, messages, run: null };
    await route.fulfill({ json: { json: bootstrap ? { ...body.json, thread: seeded } : seeded } });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  const card = page.getByRole("group", { name: "Google Drive connection", exact: true });
  await expect(card.getByRole("button", { name: "Authorize", exact: true })).toBeVisible();
  const frame = card.locator('xpath=ancestor::*[@data-testid="message-bubble-frame"]');
  const bubbleFrame = page
    .getByTestId("message-bot-bubble")
    .locator('xpath=ancestor::*[@data-testid="message-bubble-frame"]');
  const maxWidth = (element: Element) => getComputedStyle(element).maxWidth;
  expect(await frame.evaluate(maxWidth)).toBe(await bubbleFrame.evaluate(maxWidth));
  await page.evaluate(() => document.fonts.ready);
  const frameBox = await frame.boundingBox();
  const cardBox = await card.boundingBox();
  expect(frameBox).toBeTruthy();
  expect(cardBox).toBeTruthy();
  expect(Math.abs(frameBox!.width - cardBox!.width)).toBeLessThan(1);
  await testInfo.attach("card-width", {
    body: JSON.stringify({ frame: frameBox, card: cardBox }),
    contentType: "application/json",
  });

  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await captureScreenshot(page, testInfo, `app-connect-pending-${theme}`);
  }
  name = "Gmail · Work";
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("group", { name: "Gmail · Work connection", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await captureScreenshot(page, testInfo, "app-connect-account-light");
  name = "Google Drive";
  connected = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Authorize", exact: true })).toHaveCount(0);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await captureScreenshot(page, testInfo, `app-connect-connected-${theme}`);
  }
});
