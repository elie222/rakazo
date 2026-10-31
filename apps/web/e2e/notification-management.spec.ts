import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

test("attention and working lists identify the agent and expose a private sender portrait", async ({
  page,
  browser,
}, testInfo) => {
  await signup(page, `notification-state-${Date.now()}@rakazo.test`, "password12", "Notifications");
  await completeOnboarding(page);
  const writer = await createNamedBot(page, "Writer");
  await expect
    .poll(async () => {
      const active = await rpc<{ runs: Array<{ botId: string }> }>(page, "runs/list", {
        filter: "active",
      });
      return active.runs.some((run) => run.botId === writer);
    })
    .toBe(false);
  const marketing = await createNamedBot(page, "Head of Marketing");
  await rpc(page, "threads/markUnread", { botId: writer });
  await page.getByPlaceholder("Message Head of Marketing").fill("ask me which city to use");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Which city should I use?", { exact: true })).toBeVisible();
  const researcher = await createNamedBot(page, "Researcher");
  await page.getByPlaceholder("Message Researcher").fill("keep working until I stop you");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const aside = page.locator("aside").first();
  await expect(aside.getByRole("region", { name: "Needs attention" })).toContainText(
    "Head of Marketing",
  );
  await expect(aside.getByRole("region", { name: "Working", exact: true })).toContainText(
    "Researcher",
  );
  await expect(aside.getByRole("region", { name: "Unread", exact: true })).toContainText("Writer");
  await expect(
    aside
      .getByRole("button", { name: /^Head of Marketing,/ })
      .locator("svg")
      .first(),
  ).toBeVisible();
  const identity = await rpc<{ botId: string; name: string; avatar: string }>(
    page,
    "notifications/identity",
    { botId: marketing },
  );
  expect(identity).toMatchObject({ botId: marketing, name: "Head of Marketing" });
  expect(identity.avatar.length).toBeLessThanOrEqual(1400);
  const denied = await page.request.post("/rpc/notifications/identity", {
    data: { json: { botId: "unknown-bot" } },
  });
  expect(denied.status()).toBe(404);
  await captureScreenshot(page, testInfo, "notification-attention-and-agent-avatars");
  const other = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const otherPage = await other.newPage();
    await signup(
      otherPage,
      `notification-private-${Date.now()}@rakazo.test`,
      "password12",
      "Other",
    );
    await completeOnboarding(otherPage);
    const forbidden = await otherPage.request.post("/rpc/notifications/identity", {
      data: { json: { botId: marketing } },
    });
    expect(forbidden.status()).toBe(404);
  } finally {
    await other.close();
  }
  await rpc(page, "threads/stop", { botId: researcher });
});
