import { expect, type Page, test } from "@playwright/test";
import type { Bot, Routine } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function addScheduleTrigger(page: Page, freq: string) {
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "On a schedule" }).hover();
  await page.getByRole("menuitem", { name: freq, exact: true }).click();
}

async function saveAndReturn(page: Page, procedure: "routines/create" | "routines/update") {
  const saved = page.waitForResponse(
    (response) => response.url().includes(`/rpc/${procedure}`) && response.ok(),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await saved;
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Back" }).click();
}

test("routine active switch keeps its thumb inside the track", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-toggle-${stamp}@rakazo.test`, "password12", "Routine Toggle");
  await completeOnboarding(page);
  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Create Routine" }).click();

  const toggle = page.getByRole("switch", { name: "Active" });
  const thumb = toggle.locator("span");
  async function expectThumbInsets(left: number, right: number) {
    await thumb.evaluate((element) =>
      Promise.all(element.getAnimations().map(({ finished }) => finished)),
    );
    const [trackBox, thumbBox] = await Promise.all([toggle.boundingBox(), thumb.boundingBox()]);
    expect(trackBox).not.toBeNull();
    expect(thumbBox).not.toBeNull();
    expect(thumbBox!.x - trackBox!.x).toBeCloseTo(left, 1);
    expect(trackBox!.x + trackBox!.width - thumbBox!.x - thumbBox!.width).toBeCloseTo(right, 1);
  }

  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expectThumbInsets(20, 2);
  await captureScreenshot(page, testInfo, "routine-toggle-desktop-active");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expectThumbInsets(2, 20);
  await captureScreenshot(page, testInfo, "routine-toggle-desktop-inactive");

  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(await toggle.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
    "none",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expectThumbInsets(20, 2);
  await captureScreenshot(page, testInfo, "routine-toggle-mobile-active");
  await toggle.click();
  await expectThumbInsets(2, 20);
  await captureScreenshot(page, testInfo, "routine-toggle-mobile-inactive");
});

test("routine editing updates in place, preserves timezone, and deletion persists", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-crud-${stamp}@rakazo.test`, "password12", "Routine CRUD");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  const created = await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Tokyo check-in",
    prompt: "Send the original update",
    crons: ["0 9 * * *"],
    timezone: "Asia/Tokyo",
    active: true,
    notify: true,
  });
  expect(created.nextRunAt).not.toBeNull();
  expect(localSchedule(created.nextRunAt!, created.timezone)).toMatchObject({ hour: 9, minute: 0 });
  await page.reload();
  await page.getByTitle("Agent computer").click();

  await page.getByRole("button", { name: /Tokyo check-in/ }).click();
  await page.locator("label:has-text('Name') input").fill("Weekday check-in");
  await page.locator("label:has-text('Instruction') textarea").fill("Send the revised update");
  await page.getByLabel("How often").selectOption("Weekdays");
  await saveAndReturn(page, "routines/update");

  const updatedButton = page.getByRole("button", { name: /Weekday check-in/ });
  await expect(updatedButton).toHaveCount(1);
  await expect(updatedButton).toContainText("Weekdays at 9:00 AM");
  await expect(page.getByRole("button", { name: /Tokyo check-in/ })).toHaveCount(0);

  const [updated] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(updated).toMatchObject({
    name: "Weekday check-in",
    prompt: "Send the revised update",
    crons: ["0 9 * * 1-5"],
    timezone: "Asia/Tokyo",
  });
  expect(updated?.nextRunAt).not.toBeNull();
  expect(["Mon", "Tue", "Wed", "Thu", "Fri"]).toContain(
    localSchedule(updated!.nextRunAt!, updated!.timezone).weekday,
  );
  await captureScreenshot(page, testInfo, "routine-weekday-schedule");

  await updatedButton.click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete Weekday check-in?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("label:has-text('Name') input")).toHaveValue("Weekday check-in");

  await page.getByRole("button", { name: "Delete", exact: true }).click();
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

test("invalid advanced cron is rejected without creating a routine", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-invalid-${stamp}@rakazo.test`, "password12", "Invalid Routine");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Broken schedule");
  await page.locator("label:has-text('Instruction') textarea").fill("This should never run");
  await addScheduleTrigger(page, "Advanced...");
  await page.getByLabel("Cron expression").fill("61 25 * * *");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText("Enter a valid cron expression.");
  expect(await rpc<Routine[]>(page, "routines/list", { botId })).toEqual([]);
  await captureScreenshot(page, testInfo, "invalid-cron-rejected");
});

test("a successful routine create is not reported as failed when refresh fails", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `routine-refresh-${stamp}@rakazo.test`, "password12", "Routine Refresh");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Persisted routine");
  await page.locator("label:has-text('Instruction') textarea").fill("Run once each morning");
  await addScheduleTrigger(page, "Every day");

  await page.route(
    "**/rpc/routines/list",
    (route) => route.fulfill({ status: 500, body: "refresh failed" }),
    { times: 1 },
  );
  const createResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/create") && response.ok(),
  );
  const failedRefresh = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/list") && response.status() === 500,
  );

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await createResponse;
  await failedRefresh;
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "routine");
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.unroute("**/rpc/routines/list");
  const routines = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routines).toHaveLength(1);
  expect(routines[0]?.name).toBe("Persisted routine");
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
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: true,
      notify: true,
    }),
    rpc<Routine>(page, "routines/create", {
      botId: secondBot.id,
      name: "Second routine",
      prompt: "Second prompt",
      crons: ["0 9 * * *"],
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
      await route.fulfill({ status: 500, body: "save failed" });
    },
    { times: 1 },
  );
  const updateResponse = page.waitForResponse((response) =>
    response.url().includes("/rpc/routines/update"),
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
  await expect(page.getByRole("alert")).toHaveCount(0);

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

function localSchedule(iso: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: value("weekday"),
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
  };
}
