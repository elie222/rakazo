import { expect, test } from "@playwright/test";
import type { Bot, Routine } from "@rakazo/contracts";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";

test("routine editing updates in place, preserves timezone, and deletion persists", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `routine-crud-${stamp}@rakazo.test`, "password12", "Routine CRUD");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Tokyo check-in",
    prompt: "Send the original update",
    cron: "0 9 * * *",
    timezone: "Asia/Tokyo",
    active: true,
    notify: true,
  });
  await page.reload();
  await page.getByTitle("Agent computer").click();

  await page.getByRole("button", { name: /Tokyo check-in/ }).click();
  await page.locator("label:has-text('Name') input").fill("Weekday check-in");
  await page.locator("label:has-text('Instruction') textarea").fill("Send the revised update");
  await page.getByLabel("How often").selectOption("Weekdays");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  const updatedButton = page.getByRole("button", { name: /Weekday check-in/ });
  await expect(updatedButton).toHaveCount(1);
  await expect(updatedButton).toContainText("Weekdays at 9:00 AM");
  await expect(page.getByRole("button", { name: /Tokyo check-in/ })).toHaveCount(0);

  const [updated] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(updated).toMatchObject({
    name: "Weekday check-in",
    prompt: "Send the revised update",
    cron: "0 9 * * 1-5",
    timezone: "Asia/Tokyo",
  });

  await updatedButton.click();
  await page.getByRole("button", { name: "Delete routine" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete Weekday check-in?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("label:has-text('Name') input")).toHaveValue("Weekday check-in");

  await page.getByRole("button", { name: "Delete routine" }).click();
  const removeResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/remove") && response.ok(),
  );
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await removeResponse;
  await expect(updatedButton).toHaveCount(0);
  expect(await rpc<Routine[]>(page, "routines/list", { botId })).toEqual([]);

  await page.reload();
  await page.getByTitle("Agent computer").click();
  await expect(updatedButton).toHaveCount(0);
});

test("switching bots while a routine save is pending does not reopen stale state", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `routine-switch-${stamp}@rakazo.test`, "password12", "Routine Switch");
  await completeOnboarding(page);
  const firstBotId = activeBotId(page);
  const secondBot = await rpc<Bot>(page, "bots/create", {
    name: "Second",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
  await Promise.all([
    rpc<Routine>(page, "routines/create", {
      botId: firstBotId,
      name: "First routine",
      prompt: "First prompt",
      cron: "0 9 * * *",
      timezone: "UTC",
      active: true,
      notify: true,
    }),
    rpc<Routine>(page, "routines/create", {
      botId: secondBot.id,
      name: "Second routine",
      prompt: "Second prompt",
      cron: "0 9 * * *",
      timezone: "UTC",
      active: true,
      notify: true,
    }),
  ]);
  await page.reload();

  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: /First routine/ }).click();
  await page.locator("label:has-text('Name') input").fill("First routine updated");

  let releaseUpdate!: () => void;
  let sawUpdate!: () => void;
  const updateReleased = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  const updateIntercepted = new Promise<void>((resolve) => {
    sawUpdate = resolve;
  });
  await page.route(
    "**/rpc/routines/update",
    async (route) => {
      sawUpdate();
      await updateReleased;
      await route.continue();
    },
    { times: 1 },
  );
  const updateResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/update") && response.ok(),
  );

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await updateIntercepted;
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Second/ })
    .click();
  await page.waitForURL(new RegExp(`/app/${secondBot.id}$`));
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");

  releaseUpdate();
  await updateResponse;
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");

  await page.getByTitle("Agent computer").click();
  await expect(page.getByRole("button", { name: /Second routine/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /First routine/ })).toHaveCount(0);

  let releaseStaleList!: () => void;
  let sawStaleList!: () => void;
  const staleListReleased = new Promise<void>((resolve) => {
    releaseStaleList = resolve;
  });
  const staleListIntercepted = new Promise<void>((resolve) => {
    sawStaleList = resolve;
  });
  await page.route("**/rpc/routines/list", async (route) => {
    if (route.request().postData()?.includes(firstBotId) !== true) {
      await route.continue();
      return;
    }
    sawStaleList();
    await staleListReleased;
    await route.continue();
  });
  const staleListResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/routines/list") &&
      response.request().postData()?.includes(firstBotId) === true,
  );

  const botList = page.locator("aside").first();
  await botList.getByRole("button", { name: /^Chief/ }).click();
  await staleListIntercepted;
  await botList.getByRole("button", { name: /^Second/ }).click();
  await page.waitForURL(new RegExp(`/app/${secondBot.id}$`));
  releaseStaleList();
  await staleListResponse;
  await page.unroute("**/rpc/routines/list");

  await expect(page.getByRole("button", { name: /Second routine/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /First routine/ })).toHaveCount(0);
});
