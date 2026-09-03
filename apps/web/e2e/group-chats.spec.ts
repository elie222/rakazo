import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openNewBot,
  rpc,
  signup,
} from "./helpers";

async function createBot(page: import("@playwright/test").Page, name: string) {
  const botList = page.locator("aside").first();
  await openNewBot(page);
  await expect(page.getByText("New bot", { exact: true })).toBeVisible();
  await page.locator("label:has-text('Name') input").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(botList.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
  await expect(page.getByRole("combobox", { name: `Message ${name}` })).toBeVisible();
  await page.waitForURL(/\/app\/[^/]+$/);
  return activeBotId(page);
}

test("create group from + and see two bots in one transcript", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `group-${stamp}@rakazo.test`, "password12", "Group E2E");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const researcherId = await createBot(page, "Researcher");
  const writerId = await createBot(page, "Research Writer");

  await page.getByTitle("Create", { exact: true }).click();
  await page.getByRole("button", { name: "New group" }).click();
  await page.locator("label:has-text('Name') input").fill("Draft team");
  const panel = page.getByTestId("side-panel");
  await panel.getByRole("button", { name: "Researcher" }).click();
  await panel.getByRole("button", { name: "Research Writer" }).click();
  await captureScreenshot(page, testInfo, "group-creation");
  await page.route("**/rpc/groups/create", async (route) => route.abort("failed"));
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("Failed to fetch");
  await expect(page.getByRole("button", { name: "Create group", exact: true })).toBeEnabled();
  await page.unroute("**/rpc/groups/create");
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);
  const groupUrl = page.url();
  const draftGroupId = new URL(groupUrl).pathname.split("/").at(-1)!;
  const reviewGroup = await rpc<{ id: string }>(page, "groups/create", {
    name: "Review team",
    botIds: [researcherId, writerId],
  });
  await rpc(page, "voice/connect", {
    provider: "scripted",
    apiKey: "fake-group-voice-key",
  });
  await page.reload();
  await expect(page).toHaveURL(groupUrl);
  await expect(page.getByRole("combobox", { name: "Message Draft team" })).toBeVisible();

  const groups = await rpc<
    Array<{
      id: string;
      members: Array<{ botId: string; name: string; color: string; status?: string }>;
    }>
  >(page, "groups/list", {});
  const groupSnapshot = await rpc<{
    members?: Array<{ botId: string; name: string; color: string; status?: string }>;
  }>(page, "threads/get", { groupId: draftGroupId });
  await page.route("**/rpc/groups/list", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: groups.map((group) => ({
          ...group,
          members: group.members.map((member, index) => ({
            ...member,
            status: index === 0 ? "running" : "idle",
          })),
        })),
      }),
    });
  });
  await page.route("**/rpc/threads/get", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          ...groupSnapshot,
          members: groupSnapshot.members?.map((member, index) => ({
            ...member,
            status: index === 0 ? "running" : "idle",
          })),
        },
      }),
    });
  });
  await page.reload();
  // Anchor ^ so Now/Recent activity rows ("Bot · Draft team, …") do not match.
  const groupAvatar = page
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Draft team/ })
    .locator(".rakazo-group-avatar");
  await expect(groupAvatar).toBeVisible();
  await expect(groupAvatar.locator(".rakazo-bot-avatar")).toHaveCount(2);
  const workingAvatar = groupAvatar.locator('[data-working="true"]');
  await expect(workingAvatar).toHaveCount(1);
  await expect(workingAvatar.locator("svg")).toHaveCSS("animation-name", "rakazo-avatar-spin");
  await captureScreenshot(page, testInfo, "group-avatar-active");
  await page.unroute("**/rpc/groups/list");
  await page.unroute("**/rpc/threads/get");
  await page.reload();

  await page.getByTestId("bot-settings-trigger").click();
  const desktopSettings = page.getByTestId("side-panel");
  const groupName = desktopSettings.locator("label:has-text('Name') input");
  await groupName.fill("Unsaved Draft team name");
  const sidebar = page.locator("aside").first();
  await sidebar.getByRole("button", { name: /^Review team/ }).click();
  await expect(groupName).toHaveValue("Review team");
  await sidebar.getByRole("button", { name: /^Draft team/ }).click();
  await expect(groupName).toHaveValue("Draft team");
  await page.route("**/rpc/groups/update", async (route) => route.abort("failed"));
  await desktopSettings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(desktopSettings.getByRole("alert")).toHaveText("Failed to fetch");
  await expect(desktopSettings.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await page.unroute("**/rpc/groups/update");
  await desktopSettings.getByRole("button", { name: "Save", exact: true }).click();

  await page
    .getByRole("combobox", { name: "Message Draft team" })
    .fill("@Researcher unfinished draft");
  await sidebar.getByRole("button", { name: /^Review team/ }).click();
  await expect(page.getByRole("combobox", { name: "Message Review team" })).toHaveValue("");
  await sidebar.getByRole("button", { name: /^Draft team/ }).click();
  await expect(page.getByRole("combobox", { name: "Message Draft team" })).toHaveValue("");

  const composer = page.getByRole("combobox", { name: "Message Draft team" });
  await composer.fill("@Res");
  await captureScreenshot(page, testInfo, "group-mention-picker");
  await page.getByRole("option", { name: "@Research Writer", exact: true }).click();
  await expect(
    page.getByTestId("mention-chip").filter({ hasText: "Research Writer" }),
  ).toBeVisible();
  await composer.fill("turn the sources into a draft. @Res");
  await page.getByRole("option", { name: "@Researcher", exact: true }).click();
  await expect(page.getByTestId("mention-chip").filter({ hasText: "Researcher" })).toBeVisible();
  await composer.fill(`${await composer.inputValue()}gather sources.`);
  await composer.press("Enter");

  await expect(page.getByTestId("transcript")).toContainText(/handled|on it|gather/i, {
    timeout: 60_000,
  });
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText("Researcher", { exact: true }).first()).toBeVisible();
  await expect(transcript.getByText("Research Writer", { exact: true }).first()).toBeVisible();
  const researcherReply = transcript.getByText("Researcher", { exact: true }).first().locator("..");
  const [speechRequest] = await Promise.all([
    page.waitForRequest(
      (request) => request.url().includes("/api/voice/speak") && request.method() === "POST",
    ),
    researcherReply.getByRole("button", { name: "Speak this reply" }).click(),
  ]);
  expect(speechRequest.postDataJSON()).toMatchObject({ botId: researcherId });
  await captureScreenshot(page, testInfo, "group-transcript");

  await composer.fill("@Res");
  await page.getByRole("option", { name: "@Research Writer", exact: true }).click();
  await expect(
    page.getByTestId("mention-chip").filter({ hasText: "Research Writer" }),
  ).toBeVisible();
  await composer.fill("ask me which city to use");
  await composer.press("Enter");
  // threads/get / member status can observe waiting_input before realtime paints the ask card.
  await expect(page.getByRole("button", { name: /Research Writer waiting_input/ })).toBeVisible({
    timeout: 60_000,
  });
  const cityAsk = page.locator("p").filter({ hasText: /^Which city should I use\?$/ });
  if ((await cityAsk.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("combobox", { name: "Message Draft team" })).toBeVisible({
      timeout: 15_000,
    });
  }
  await expect(cityAsk).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Edit first" }).click();
  await page.getByRole("textbox", { name: "Answer" }).fill("Paris");
  await page.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByText("Answered: Paris", { exact: true })).toBeVisible({ timeout: 30_000 });

  const firstMessage = transcript.locator("[data-message-id]").first();
  await firstMessage.hover();
  const replyButton = firstMessage.getByRole("button", { name: "Reply" });
  await expect(replyButton).toBeVisible();
  await replyButton.click();
  await expect(page.getByTestId("reply-chip")).toContainText(/Replying to/);
  await page.getByRole("button", { name: "Cancel reply" }).click();

  let releaseReviewSnapshot!: () => void;
  let sawReviewSnapshot!: () => void;
  const reviewSnapshotReleased = new Promise<void>((resolve) => {
    releaseReviewSnapshot = resolve;
  });
  const reviewSnapshotIntercepted = new Promise<void>((resolve) => {
    sawReviewSnapshot = resolve;
  });
  await page.route("**/rpc/threads/get", async (route) => {
    if (route.request().postData()?.includes(reviewGroup.id) !== true) {
      await route.continue();
      return;
    }
    sawReviewSnapshot();
    await reviewSnapshotReleased;
    await route.continue();
  });
  await sidebar.getByRole("button", { name: /^Review team/ }).click();
  await reviewSnapshotIntercepted;
  await expect(page).toHaveURL(new RegExp(`/app/g/${reviewGroup.id}$`));
  await expect(page.getByTestId("transcript")).not.toContainText("Answered: Paris");
  releaseReviewSnapshot();
  await expect(page.getByRole("combobox", { name: "Message Review team" })).toBeVisible();
  await page.unroute("**/rpc/threads/get");
  await sidebar.getByRole("button", { name: /^Draft team/ }).click();
  await expect(page.getByText("Answered: Paris", { exact: true })).toBeVisible();

  await composer.fill(
    "@Researcher write path notes/group-preview.md and attach it to the thread says # Group artifact",
  );
  await composer.press("Enter");
  const groupMarkdown = page.getByRole("button", { name: "Preview group-preview.md" });
  await expect(groupMarkdown).toBeVisible({ timeout: 30_000 });
  await groupMarkdown.click();
  const markdownDialog = page.getByRole("dialog", { name: "group-preview.md" });
  await expect(markdownDialog.getByRole("heading", { name: "Group artifact" })).toBeVisible();
  await markdownDialog.getByRole("button", { name: "Close preview" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  expect((await transcript.boundingBox())?.width).toBeGreaterThan(350);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("button", { name: "Close navigation" })).toBeVisible();
  await page.getByRole("button", { name: "Close navigation" }).click();
  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("side-panel");
  await expect(settings).toHaveAttribute("data-panel", "group-settings");
  expect((await settings.boundingBox())?.width).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "group-settings-mobile");

  await rpc(page, "groups/remove", { groupId: reviewGroup.id });
  await page.goto(`/app/g/${reviewGroup.id}`);
  await page.waitForURL(/\/app\/(?!g\/)[^/]+$/);
  await expect(page.getByRole("combobox", { name: /Message/ })).toBeVisible();
});
