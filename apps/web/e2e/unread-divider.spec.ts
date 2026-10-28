import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";

test("a chat opens with a New divider above replies that arrived while away", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `unread-divider-${stamp}@rakazo.test`, "password12", "Unread Divider");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const chiefId = activeBotId(page);
  // A brand-new chat is all new, so there is nothing read above to divide from.
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
  await expect(page.locator(`[data-roster-bot-id="${chiefId}"]`)).not.toHaveAttribute(
    "data-roster-unread",
    "true",
  );
  await expect(page.getByTestId("unread-divider")).toHaveCount(0);
  const otherId = await createNamedBot(page, "Elsewhere");

  // Chief answers while the user is in another chat.
  const question = "Plan my week";
  await rpc(page, "threads/send", { botId: chiefId, text: question });
  await expect
    .poll(
      async () => {
        const bots = await rpc<Array<{ id: string; unread: boolean; status: string }>>(
          page,
          "bots/list",
          {},
        );
        const chief = bots.find((bot) => bot.id === chiefId);
        return chief?.unread === true && !["queued", "leased", "running"].includes(chief.status);
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  await page.goto(`/app/${chiefId}`);
  const divider = page.getByTestId("unread-divider");
  await expect(divider).toBeVisible();
  await expect(divider).toContainText("New messages");
  // The user's own question stays above the line; Chief's reply starts the new part.
  const lastSeen = divider.locator("xpath=preceding-sibling::div[@data-message-id][1]");
  await expect(lastSeen).toHaveText(question);
  await expect(lastSeen.locator(".justify-end").first()).toBeVisible();
  const firstNew = divider.locator("xpath=following-sibling::div[@data-message-id][1]");
  await expect(firstNew.locator(".justify-start").first()).toBeVisible();
  // It opens at the latest message, not at the divider.
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "chat-unread-divider");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureScreenshot(page, testInfo, "chat-unread-divider-dark");
  await page.emulateMedia({ colorScheme: "light" });

  // Writing in the chat means the user has caught up.
  const followUp = `Thanks ${stamp}`;
  await page.getByPlaceholder("Message Chief").fill(followUp);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("message-user-bubble").filter({ hasText: followUp })).toBeVisible();
  await expect(divider).toHaveCount(0);
  // Let Chief answer here so its reply is read before leaving.
  await expect
    .poll(
      async () => {
        const bots = await rpc<Array<{ id: string; unread: boolean; status: string }>>(
          page,
          "bots/list",
          {},
        );
        const chief = bots.find((bot) => bot.id === chiefId);
        return chief?.unread === false && !["queued", "leased", "running"].includes(chief.status);
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  // Once read, the next visit has no divider.
  await page.goto(`/app/${otherId}`);
  await expect(page.getByPlaceholder("Message Elsewhere")).toBeVisible();
  await page.goto(`/app/${chiefId}`);
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await expect(
    page.locator("[data-message-id]").filter({ hasText: question }).first(),
  ).toBeVisible();
  await expect(divider).toHaveCount(0);
  await captureScreenshot(page, testInfo, "chat-unread-divider-read");
});

test("a late read answer from a chat you left doesn't remove the divider in the open chat", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `unread-late-${stamp}@rakazo.test`, "password12", "Unread Late");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const chiefId = activeBotId(page);
  const otherId = await createNamedBot(page, "Elsewhere");

  await rpc(page, "threads/send", { botId: chiefId, text: `Plan the week ${stamp}` });
  await expect
    .poll(
      async () => {
        const bots = await rpc<Array<{ id: string; unread: boolean; status: string }>>(
          page,
          "bots/list",
          {},
        );
        const chief = bots.find((bot) => bot.id === chiefId);
        return chief?.unread === true && !["queued", "leased", "running"].includes(chief.status);
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  // Hold Elsewhere's read answer until after Chief's divider is showing.
  let releaseOther: () => void = () => undefined;
  const otherHeld = new Promise<void>((resolve) => {
    releaseOther = resolve;
  });
  await page.route("**/rpc/threads/markRead", async (route) => {
    if (route.request().postData()?.includes(otherId)) await otherHeld;
    await route.continue();
  });

  await page.goto(`/app/${otherId}`);
  await expect(page.getByPlaceholder("Message Elsewhere")).toBeVisible();
  await page.locator(`[data-roster-bot-id="${chiefId}"]`).click();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  const divider = page.getByTestId("unread-divider");
  await expect(divider).toBeVisible();

  const otherAnswered = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/threads/markRead") &&
      (response.request().postData()?.includes(otherId) ?? false),
  );
  releaseOther();
  await otherAnswered;
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(divider).toBeVisible();
});

test("marking a message unread brings the chat back with New above the reply from there", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `unread-message-${stamp}@rakazo.test`, "password12", "Unread Message");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const chiefId = activeBotId(page);
  const otherId = await createNamedBot(page, "Elsewhere");
  const settled = async () =>
    expect
      .poll(
        async () => {
          const bots = await rpc<Array<{ id: string; status: string }>>(page, "bots/list", {});
          const chief = bots.find((bot) => bot.id === chiefId);
          return Boolean(chief && !["queued", "leased", "running"].includes(chief.status));
        },
        { timeout: 60_000 },
      )
      .toBe(true);
  // A closing menu stays mounted while it animates out; wait for it before opening the next.
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem")).toHaveCount(0);
  };
  const first = `First question ${stamp}`;
  const second = `Second question ${stamp}`;
  await rpc(page, "threads/send", { botId: chiefId, text: first });
  await settled();
  await rpc(page, "threads/send", { botId: chiefId, text: second });
  await settled();

  await page.goto(`/app/${chiefId}`);
  const firstReply = page
    .locator("[data-message-id]")
    .filter({ hasText: `handled: ${first}` })
    .first();
  await expect(firstReply).toBeVisible();
  await expect(page.locator(`[data-roster-bot-id="${chiefId}"]`)).not.toHaveAttribute(
    "data-roster-unread",
    "true",
  );
  await firstReply.hover();
  await firstReply.getByRole("button", { name: "More" }).click();
  const markUnread = page.getByRole("menuitem", { name: "Mark as unread", exact: true });
  await expect(page.getByRole("menuitem")).toHaveText(["Reply", "Mark as unread", "Copy"]);
  await captureScreenshot(page, testInfo, "message-mark-unread-menu");
  await markUnread.click();
  await expect(page.locator(`[data-roster-bot-id="${chiefId}"]`)).toHaveAttribute(
    "data-roster-unread",
    "true",
  );

  // The completed action disappears from this message, while the chat remains unread.
  await firstReply.hover();
  await firstReply.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Reply", "Copy"]);
  // The scroll viewport continues behind the rounded corners, with no rectangular cutoff.
  const transcriptBounds = await page.getByTestId("transcript").boundingBox();
  const composerBounds = await page.getByTestId("composer-bar").boundingBox();
  expect(transcriptBounds).not.toBeNull();
  expect(composerBounds).not.toBeNull();
  expect(transcriptBounds!.y + transcriptBounds!.height - composerBounds!.y).toBe(28);
  await captureScreenshot(page, testInfo, "message-marked-unread-menu");
  await closeMenu();
  // The menu's modal backdrop intentionally intercepts hits until it finishes closing.
  await expect
    .poll(() =>
      page.evaluate(
        ({ x, y }) =>
          Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="transcript"]')),
        { x: composerBounds!.x + 8, y: composerBounds!.y + 3 },
      ),
    )
    .toBe(true);

  // Reading another chat from the sidebar must not restore the completed action here.
  const otherRow = page.locator(`[data-roster-bot-id="${otherId}"]`);
  await otherRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as Unread", exact: true }).click();
  await expect(otherRow).toHaveAttribute("data-roster-unread", "true");
  await otherRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as Read", exact: true }).click();
  await expect(otherRow).not.toHaveAttribute("data-roster-unread", "true");
  await firstReply.hover();
  await firstReply.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Reply", "Copy"]);
  await closeMenu();

  await page.goto(`/app/${otherId}`);
  await expect(page.getByPlaceholder("Message Elsewhere")).toBeVisible();
  await page.goto(`/app/${chiefId}`);
  const divider = page.getByTestId("unread-divider");
  await expect(divider).toBeVisible();
  await expect(divider.locator("xpath=following-sibling::div[@data-message-id][1]")).toContainText(
    `handled: ${first}`,
  );
  await captureScreenshot(page, testInfo, "message-mark-unread-divider");
  // A new visit reads the chat and makes the action available again.
  await firstReply.hover();
  await firstReply.getByRole("button", { name: "More" }).click();
  await expect(markUnread).toBeVisible();
  await closeMenu();

  // The user's own message offers it too; New then starts at the reply after it.
  const secondQuestion = page.locator("[data-message-id]").filter({ hasText: second }).first();
  await secondQuestion.hover();
  await secondQuestion.getByRole("button", { name: "More" }).click();
  await markUnread.click();
  await expect(page.locator(`[data-roster-bot-id="${chiefId}"]`)).toHaveAttribute(
    "data-roster-unread",
    "true",
  );
  await page.goto(`/app/${otherId}`);
  await expect(page.getByPlaceholder("Message Elsewhere")).toBeVisible();
  await page.goto(`/app/${chiefId}`);
  await expect(divider.locator("xpath=following-sibling::div[@data-message-id][1]")).toContainText(
    `handled: ${second}`,
  );
});
