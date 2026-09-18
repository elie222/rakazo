import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  realSandboxTimeout,
  rpc,
  signup,
} from "./helpers";

test("needs-you computer card opens the computer", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `needs-you-${stamp}@rakazo.test`, "password12", "Needs You");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("install the gsc cli and sign in");
  await page.keyboard.press("Enter");

  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      {
        timeout: realSandboxTimeout(90_000, 30_000),
        message: "the protected-input run must be ready for takeover",
      },
    )
    .toBe("waiting_takeover");

  const card = page.getByTestId("computer-card");
  if ((await card.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText("Computer", { exact: true })).toBeVisible();
  await expect(card.getByText("Needs you", { exact: true })).toBeVisible();
  const open = card.getByTestId("computer-card-open");
  await expect(open).toBeVisible();
  await expect(open).toHaveText("Open");
  await captureScreenshot(page, testInfo, "computer-needs-you-card");

  await open.click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await expect(page.getByTestId("computer-viewport")).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-needs-you-card-open");
});

test("needs-you computer card opens a group member bot computer", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `needs-you-group-${stamp}@rakazo.test`, "password12", "Needs You Group");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const writerId = await createNamedBot(page, "Writer");
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Needs you team",
    botIds: [chiefId, writerId],
  });

  await mockGroupComputerCard(page, group.id, writerId);
  await mockMemberComputerRpcs(page, writerId);

  await page.goto(`/app/g/${group.id}`);
  await expect(page.getByRole("combobox", { name: /Message Needs you team/ })).toBeVisible();

  const card = page.getByTestId("computer-card");
  await expect(card).toBeVisible();
  await expect(card.getByText("Computer", { exact: true })).toBeVisible();
  await expect(card.getByText("Needs you", { exact: true })).toBeVisible();
  const open = card.getByTestId("computer-card-open");
  await expect(open).toBeVisible();
  await expect(open).toHaveText("Open");
  await captureScreenshot(page, testInfo, "computer-needs-you-card-group");

  await open.click();
  await expect(page).toHaveURL(new RegExp(`/app/g/${group.id}`));
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await expect(page.getByTestId("computer-viewport")).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-needs-you-card-group-open");
});

async function mockGroupComputerCard(page: Page, groupId: string, botId: string) {
  await page.route("**/rpc/threads/get", async (route) => {
    const post = route.request().postData() ?? "";
    if (!post.includes(groupId)) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const parsed = (await response.json()) as {
      json?: { threadId: string; cursor: number; messages?: Array<{ id?: string }> };
    };
    const snap = parsed.json;
    if (!snap) {
      await route.fulfill({ response });
      return;
    }
    const messages = snap.messages ?? [];
    if (messages.some((message) => message.id === "msg-needs-you-computer")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ json: snap }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          ...snap,
          messages: [
            ...messages,
            {
              id: "msg-needs-you-computer",
              threadId: snap.threadId,
              seq: Math.max(snap.cursor, 0) + 1,
              role: "bot",
              botId,
              blocks: [{ kind: "computer", state: "Needs you", text: "Sign in to continue." }],
              createdAt: new Date().toISOString(),
            },
          ],
        },
      }),
    });
  });
}

async function mockMemberComputerRpcs(page: Page, botId: string) {
  const status = {
    botId,
    mode: "team",
    kind: "fake",
    state: "running",
    controlHolder: "user",
    controlBotId: botId,
    takeoverRequested: true,
    screenAvailable: true,
    screenWidth: 1024,
    screenHeight: 768,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
  };
  const computerJson = JSON.stringify({ json: status });
  const fulfillForBot = async (route: Route, body: string) => {
    expect(route.request().postDataJSON()).toMatchObject({ json: { botId } });
    await route.fulfill({ contentType: "application/json", body });
  };
  await page.route("**/rpc/computer/boot", async (route) => {
    await fulfillForBot(route, computerJson);
  });
  await page.route("**/rpc/computer/status", async (route) => {
    await fulfillForBot(route, computerJson);
  });
  await page.route("**/rpc/computer/takeover", async (route) => {
    await fulfillForBot(
      route,
      JSON.stringify({
        json: {
          leaseId: "lease-needs-you",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    );
  });
  await page.route("**/rpc/computer/screenUrl", async (route) => {
    await fulfillForBot(route, JSON.stringify({ json: { url: null } }));
  });
  await page.route("**/rpc/computer/heartbeat", async (route) => {
    await fulfillForBot(route, JSON.stringify({ json: { ok: true } }));
  });
}
