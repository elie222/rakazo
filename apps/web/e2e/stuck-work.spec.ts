import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

const EXPIRED_TAKEOVER = "Stopped. This was still waiting for you on the screen.";
const EXPIRED_MESSAGE_ID = "msg-stuck-expired";

type ThreadCarrier = {
  threadId?: string;
  cursor?: number;
  messages?: unknown[];
  thread?: ThreadCarrier;
};

/** Render fixture only. expireStuckRun reads the saved thread line back in its unit test. */
function injectExpiredStatus(body: { json?: ThreadCarrier }) {
  const targets = [body.json, body.json?.thread].filter((target): target is ThreadCarrier =>
    Boolean(target?.threadId && Array.isArray(target.messages)),
  );
  for (const target of targets) {
    const messages = target.messages ?? [];
    if (
      messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "id" in message &&
          message.id === EXPIRED_MESSAGE_ID,
      )
    ) {
      continue;
    }
    const seq = Math.max(target.cursor ?? 0, 0) + 1;
    target.cursor = seq;
    messages.push({
      id: EXPIRED_MESSAGE_ID,
      threadId: target.threadId,
      seq,
      role: "system",
      blocks: [{ kind: "meta", text: EXPIRED_TAKEOVER }],
      createdAt: new Date().toISOString(),
    });
  }
}

function activityRow(page: Page, botName: string) {
  return page.locator("aside").getByRole("button", {
    name: new RegExp(`^${botName}, `),
  });
}

async function captureActivitySidebar(
  page: Page,
  testInfo: Parameters<typeof captureScreenshot>[1],
  name: string,
) {
  const aside = page.locator("aside").first();
  const box = await aside.boundingBox();
  if (box) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      path: screenshotPath,
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: Math.min(box.width + 24, 360),
        height: Math.min(Math.max(box.height, 420), 720),
      },
    });
    await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
    return;
  }
  await captureScreenshot(page, testInfo, name);
}

test("aged queued work is marked and an expired wait leaves a status line", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `stuck-${stamp}@rakazo.test`, "password12", "Stuck");
  await completeOnboarding(page);

  const agedAt = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
  await page.route("**/rpc/runs/list", async (route) => {
    const body = route.request().postDataJSON() as { json?: { filter?: string } } | null;
    const runs =
      body?.json?.filter === "active"
        ? [
            {
              runId: "run-aged",
              botId: "bot-aged",
              botName: "Chief",
              groupId: null,
              groupName: null,
              threadId: "thread-aged",
              status: "queued",
              trigger: "user",
              notificationsEnabled: true,
              promptSnippet: "finish the report",
              updatedAt: agedAt,
            },
          ]
        : [];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { runs } }),
    });
  });

  const activityToggle = page.getByRole("button", { name: "Activity", exact: true });
  await activityToggle.click();
  await page.reload();
  await expect(activityToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Loading activity…")).toBeHidden({ timeout: 20_000 });
  const row = activityRow(page, "Chief");
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText("2d ago");
  await expect(row.locator(".text-warning").filter({ hasText: "Queued" })).toBeVisible();
  await captureActivitySidebar(page, testInfo, "stuck-queued-activity");

  // A reload paints bootstrap.thread and skips threads/get when that thread is the open bot.
  const fulfillExpiredStatus = async (route: Parameters<Parameters<typeof page.route>[1]>[0]) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: ThreadCarrier };
    injectExpiredStatus(body);
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: JSON.stringify(body),
    });
  };
  await page.route("**/rpc/bootstrap", fulfillExpiredStatus);
  await page.route("**/rpc/threads/get", fulfillExpiredStatus);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("combobox", { name: /^Message/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(EXPIRED_TAKEOVER)).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(page, testInfo, "stuck-expired-status");
});
