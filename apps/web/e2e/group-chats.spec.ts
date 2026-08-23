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
  await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
  await page.waitForURL(/\/app\/[^/]+$/);
  return activeBotId(page);
}

test("create group from + and see two bots in one transcript", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `group-${stamp}@rakazo.test`, "password12", "Group E2E");
  await completeOnboarding(page, ["A bit of everything", "Clear and tight"]);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const researcherId = await createBot(page, "Researcher");
  const writerId = await createBot(page, "Research Writer");

  await page.getByTitle("Create").click();
  await page.getByRole("button", { name: "New group" }).click();
  await page.locator("label:has-text('Name') input").fill("Draft team");
  const panel = page.getByTestId("side-panel");
  await panel.getByRole("button", { name: "Researcher" }).click();
  await panel.getByRole("button", { name: "Research Writer" }).click();
  await captureScreenshot(page, testInfo, "group-creation");
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);
  const groupUrl = page.url();
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
  await expect(page.getByPlaceholder("Message Draft team")).toBeVisible();

  await page.getByTestId("bot-settings-trigger").click();
  const desktopSettings = page.getByTestId("side-panel");
  const groupName = desktopSettings.locator("label:has-text('Name') input");
  await groupName.fill("Unsaved Draft team name");
  const sidebar = page.locator("aside").first();
  await sidebar.getByRole("button", { name: /Review team/ }).click();
  await expect(groupName).toHaveValue("Review team");
  await sidebar.getByRole("button", { name: /Draft team/ }).click();
  await expect(groupName).toHaveValue("Draft team");
  await desktopSettings.getByRole("button", { name: "Save", exact: true }).click();

  await page.getByPlaceholder("Message Draft team").fill("@Researcher unfinished draft");
  await sidebar.getByRole("button", { name: /Review team/ }).click();
  await expect(page.getByPlaceholder("Message Review team")).toHaveValue("");
  await sidebar.getByRole("button", { name: /Draft team/ }).click();
  await expect(page.getByPlaceholder("Message Draft team")).toHaveValue("");

  const composer = page.getByPlaceholder("Message Draft team");
  await composer.fill("@Res");
  await captureScreenshot(page, testInfo, "group-mention-picker");
  await page.getByRole("button", { name: "@Research Writer", exact: true }).click();
  await composer.fill(`${await composer.inputValue()} turn the sources into a draft. @Res`);
  await page.getByRole("button", { name: "@Researcher", exact: true }).click();
  await composer.fill(`${await composer.inputValue()} gather sources.`);
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

  await composer.fill("@Research Writer ask me which city to use");
  await composer.press("Enter");
  await expect(page.getByText("Which city should I use?", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Edit first" }).click();
  await page.getByRole("textbox", { name: "Answer" }).fill("Paris");
  await page.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByText("Answered: Paris", { exact: true })).toBeVisible({ timeout: 30_000 });

  const replyButton = transcript.getByRole("button", { name: "Reply" }).first();
  await replyButton.focus();
  await expect(replyButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Replying to", { exact: true })).toBeVisible();
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
  await sidebar.getByRole("button", { name: /Review team/ }).click();
  await reviewSnapshotIntercepted;
  await expect(page).toHaveURL(new RegExp(`/app/g/${reviewGroup.id}$`));
  await expect(page.getByTestId("transcript")).not.toContainText("Answered: Paris");
  releaseReviewSnapshot();
  await expect(page.getByPlaceholder("Message Review team")).toBeVisible();
  await page.unroute("**/rpc/threads/get");
  await sidebar.getByRole("button", { name: /Draft team/ }).click();
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
  await expect(page.getByPlaceholder(/Message/)).toBeVisible();
});
