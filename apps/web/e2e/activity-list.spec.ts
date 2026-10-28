import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

/** Activity rows sit above `[data-sidebar-group]` bots; match their aria-label. */
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
  const toggle = page.getByRole("button", { name: "Activity", exact: true });
  await toggle.scrollIntoViewIfNeeded();
  // Keep the header (bell + Create) in frame with the Now/Recent list.
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

test("sidebar Now and Recent surface active and terminal runs", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `activity-${stamp}@rakazo.test`, "password12", "Activity");
  await completeOnboarding(page);

  const aside = page.locator("aside").first();
  const activityToggle = page.getByRole("button", { name: "Activity", exact: true });
  await expect(activityToggle).toHaveAttribute("aria-pressed", "false");
  await expect(activityToggle).toHaveAttribute("data-activity-mode", "off");
  await expect(aside.getByText("Now", { exact: true })).toHaveCount(0);
  await expect(aside.getByText("Recent", { exact: true })).toHaveCount(0);
  await expect(aside.getByRole("status", { name: "Loading activity…" })).toHaveCount(0);
  await expect(aside.locator("[data-sidebar-group]").getByText("Chief").first()).toBeVisible();
  await captureActivitySidebar(page, testInfo, "57-activity-mode-off");

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("keep working until I stop you");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
    timeout: 30_000,
  });

  await activityToggle.click();
  await expect(activityToggle).toHaveAttribute("aria-pressed", "true");
  await expect(activityToggle).toHaveAttribute("data-activity-mode", "on");

  // Remount ActivityList so the first poll sees the in-flight run (15s interval otherwise).
  await page.reload();
  await expect(activityToggle).toHaveAttribute("aria-pressed", "true");
  await expect(activityToggle).toHaveAttribute("data-activity-mode", "on");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("status", { name: "Loading activity…" })).toBeHidden({
    timeout: 20_000,
  });
  await expect(aside.getByText("Now", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(activityRow(page, "Chief")).toBeVisible();
  await expect(activityRow(page, "Chief")).toContainText(/keep working|Running|Queued|Starting/i);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const filtersButton = aside.getByRole("button", { name: "Filters", exact: true });
  await expect(filtersButton).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("activity-status-filter")).toBeHidden();
  await expect(page.getByTestId("activity-date-from")).toBeHidden();
  await expect(page.getByTestId("activity-date-to")).toBeHidden();
  await captureActivitySidebar(page, testInfo, "58-activity-now");
  const runSearch = aside.getByRole("textbox", { name: "Search runs", exact: true });
  await expect(aside.getByRole("textbox")).toHaveCount(1);
  const searchBox = (await page.getByTestId("sidebar-search").boundingBox())!;
  const rowBox = (await activityRow(page, "Chief").boundingBox())!;
  expect(Math.abs(searchBox.x - rowBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(searchBox.width - rowBox.width)).toBeLessThanOrEqual(1);
  await runSearch.fill("keep working");
  await expect(activityRow(page, "Chief")).toBeVisible();
  await expect(aside.getByTestId("activity-filter-indicator")).toHaveCount(0);
  await captureActivitySidebar(page, testInfo, "58a-activity-now-search");
  await runSearch.fill("no-such-run");
  await expect(activityRow(page, "Chief")).toHaveCount(0);
  // Run searches must never invoke the space-wide search surface.
  await expect(aside.getByText("No runs match these filters.")).toBeVisible();
  await runSearch.press("Escape");
  await expect(runSearch).toHaveValue("");
  await expect(activityRow(page, "Chief")).toBeVisible();
  await filtersButton.focus();
  await page.keyboard.press("Enter");
  await expect(filtersButton).toHaveAttribute("aria-expanded", "true");
  await page.getByTestId("activity-status-filter").selectOption("running");
  await expect(aside.getByTestId("activity-filter-indicator")).toBeVisible();
  await captureActivitySidebar(page, testInfo, "58b-activity-now-filters");
  await filtersButton.click();
  await expect(page.getByTestId("activity-status-filter")).toBeHidden();
  await expect(aside.getByTestId("activity-filter-indicator")).toBeVisible();
  await page.getByTestId("activity-reset-filters").click();
  await expect(aside.getByTestId("activity-filter-indicator")).toHaveCount(0);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureActivitySidebar(page, testInfo, "58c-activity-now-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await runSearch.fill("Chief");
  await activityToggle.click();
  await aside.getByTestId("sidebar-search-trigger").click();
  const normalSearch = aside.getByRole("textbox", { name: "Search", exact: true });
  await expect(normalSearch).toHaveValue("");
  await normalSearch.fill("Chief");
  await expect(aside.getByTestId("activity-list")).toHaveCount(0);
  await activityToggle.click();
  await expect(runSearch).toHaveValue("");
  await expect(filtersButton).toHaveAttribute("aria-expanded", "false");
  await expect(activityRow(page, "Chief")).toBeVisible();

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await expect(activityToggle).toHaveAttribute("aria-pressed", "true");
  await expect(activityToggle).toHaveAttribute("data-activity-mode", "on");
  await expect(page.getByRole("status", { name: "Loading activity…" })).toBeHidden({
    timeout: 20_000,
  });
  await expect(aside.getByText("Recent", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(activityRow(page, "Chief")).toBeVisible();
  await expect(activityRow(page, "Chief")).toContainText(/Cancelled|keep working/i);
  await expect(aside.getByText("Now", { exact: true })).toHaveCount(0);
  await captureActivitySidebar(page, testInfo, "59-activity-recent");

  const activitySearch = aside.getByRole("textbox", { name: "Search runs", exact: true });
  await expect(aside.getByRole("textbox")).toHaveCount(1);
  await activitySearch.fill("Chief");
  await expect(activityRow(page, "Chief")).toBeVisible();
  await expect(aside.getByText("Recent", { exact: true })).toBeVisible();
  await captureActivitySidebar(page, testInfo, "60-activity-search-match");

  await activitySearch.fill("no-such-run");
  await expect(aside.getByText("No runs match these filters.")).toBeVisible();
  await expect(activityRow(page, "Chief")).toHaveCount(0);
  await expect(aside.getByText("Recent", { exact: true })).toHaveCount(0);
  await captureActivitySidebar(page, testInfo, "61-activity-filters-empty");

  await page.getByTestId("activity-reset-filters").click();
  await expect(activityRow(page, "Chief")).toBeVisible();

  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByTestId("activity-status-filter").selectOption("failed");
  await expect(aside.getByText("No runs match these filters.")).toBeVisible();
  await expect(activityRow(page, "Chief")).toHaveCount(0);
  await page.getByTestId("activity-reset-filters").click();
  await expect(activityRow(page, "Chief")).toBeVisible();

  await page.getByTestId("activity-date-from").fill("2999-01-01");
  await expect(aside.getByText("No runs match these filters.")).toBeVisible();
  await expect(activityRow(page, "Chief")).toHaveCount(0);
  await page.getByTestId("activity-reset-filters").click();
  await expect(activityRow(page, "Chief")).toBeVisible();

  await page.getByTestId("activity-date-to").fill("2000-01-01");
  await expect(aside.getByText("No runs match these filters.")).toBeVisible();
  await expect(activityRow(page, "Chief")).toHaveCount(0);
});

test("activity filters keep retry when a refresh fails", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `activity-retry-${stamp}@rakazo.test`, "password12", "Activity");
  await completeOnboarding(page);
  const now = new Date();

  type Phase = "ok" | "empty" | "fail" | "hang";
  let phase: Phase = "ok";
  let releaseHang: (() => void) | null = null;
  let hang: Promise<void> | null = null;
  let released = false;
  const run = {
    runId: "run-filter",
    botId: "bot-filter",
    botName: "Chief",
    groupId: null,
    groupName: null,
    threadId: "thread-filter",
    status: "running",
    trigger: "user",
    notificationsEnabled: false,
    agentMessage: null,
    promptSnippet: "filter me",
    updatedAt: new Date(now.getTime() - 45_000).toISOString(),
  };

  const agentRun = {
    ...run,
    runId: "run-agent",
    botId: "bot-agent",
    botName: "Helper",
    trigger: "bot_message",
    agentMessage: { fromBotName: "Scout", kind: "update", text: "filter me" },
    promptSnippet: "Update from Scout: filter me",
  };

  await page.route("**/rpc/runs/list", async (route) => {
    if (phase === "hang" && !released) {
      hang ??= new Promise((resolve) => {
        releaseHang = () => {
          released = true;
          phase = "empty";
          resolve();
        };
      });
      await hang;
    }
    if (phase === "fail") {
      await route.fulfill({ status: 500, body: "activity unavailable" });
      return;
    }
    const body = route.request().postDataJSON() as { json?: { filter?: string } } | null;
    const runs = phase === "ok" && body?.json?.filter === "active" ? [run, agentRun] : [];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { runs } }),
    });
  });

  const aside = page.locator("aside").first();
  const activityToggle = page.getByRole("button", { name: "Activity", exact: true });
  await activityToggle.click();
  // The list refreshes every 15s; drive that poll with a controlled clock.
  await page.clock.install();
  await page.clock.setFixedTime(now);
  await page.reload();
  await expect(activityToggle).toHaveAttribute("aria-pressed", "true");
  await expect(activityRow(page, "Chief")).toBeVisible({ timeout: 20_000 });

  await expect(activityRow(page, "Chief")).toContainText("filter me");
  await expect(activityRow(page, "Chief").getByText("just now", { exact: true })).toBeVisible();
  await expect(activityRow(page, "Helper")).toContainText("Update from Scout: filter me");
  await captureActivitySidebar(page, testInfo, "61a-activity-first-minute");
  const activitySearch = aside.getByRole("textbox", { name: "Search runs", exact: true });
  await activitySearch.fill("Update from Scout");
  await expect(activityRow(page, "Helper")).toBeVisible();
  await expect(activityRow(page, "Chief")).toHaveCount(0);
  await activitySearch.fill("Chief");

  phase = "empty";
  await page.clock.fastForward(15_000);
  await expect(activityRow(page, "Chief")).toHaveCount(0);
  await expect(aside.getByText("No runs match these filters.")).toHaveCount(0);
  await expect(activitySearch).toHaveValue("Chief");

  phase = "fail";
  await page.clock.fastForward(15_000);
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  await expect(aside.getByText("No runs match these filters.")).toHaveCount(0);
  await expect(activitySearch).toHaveValue("Chief");

  phase = "hang";
  await retry.click();
  await expect(aside.getByRole("status", { name: "Loading activity…" })).toBeVisible();
  await expect(aside.getByText("No runs match these filters.")).toHaveCount(0);
  await expect.poll(() => releaseHang !== null).toBe(true);
  releaseHang?.();
  await expect(aside.getByRole("status", { name: "Loading activity…" })).toBeHidden({
    timeout: 20_000,
  });
  await expect(retry).toHaveCount(0);
  await expect(aside.getByText("No runs match these filters.")).toHaveCount(0);
  await expect(activitySearch).toHaveValue("Chief");
});
