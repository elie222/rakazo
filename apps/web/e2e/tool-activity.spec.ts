import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/tool-activity.html";
const REPLY_TEXT = "Tuesday at 2 pm is free.";
const NOTE_TEXT = "Anna is free all Tuesday afternoon.";
const STORAGE_KEY = "rakazo.showToolActivity";

const DESKTOP = { name: "desktop-1440x900", width: 1440, height: 900 };
const PHONE = { name: "mobile-390x844", width: 390, height: 844 };

async function openThread(page: Page, phase: "live" | "done") {
  await page.goto(`${fixture}?view=thread&phase=${phase}`);
  await expect(page.getByTestId("message-user-bubble")).toBeVisible();
}

/** Cards stay hidden until this browser saved "on". Seed only when a test needs them visible. */
async function seedToolActivityOn(page: Page) {
  await page.addInitScript((key) => {
    if (localStorage.getItem(key) == null) localStorage.setItem(key, "on");
  }, STORAGE_KEY);
}

async function setToggle(page: Page, on: boolean) {
  await page.goto(`${fixture}?view=settings`);
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  const toggle = settings.getByTestId("tool-activity-toggle");
  await expect(toggle).toBeVisible();
  if (on) await expect(toggle).not.toBeChecked();
  else await expect(toggle).toBeChecked();
  await toggle.click();
  if (on) await expect(toggle).toBeChecked();
  else await expect(toggle).not.toBeChecked();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))
    .toBe(on ? "on" : "off");
  await toggle.scrollIntoViewIfNeeded();
}

/** Lives through a run on one screen: the open live card, the folded reply, and the opened rows. */
async function tourToolActivity(page: Page, testInfo: TestInfo, viewport: typeof DESKTOP) {
  await page.setViewportSize(viewport);

  await openThread(page, "live");
  const liveLine = page.getByTestId("tool-activity-line");
  await expect(liveLine).toHaveCount(1);
  await expect(page.getByTestId("message-bot-bubble")).toHaveCount(0);
  const liveCard = page.getByTestId("tool-activity");
  const liveSummary = liveCard.locator("button[aria-expanded]").first();
  await expect(liveSummary).toHaveAttribute("aria-expanded", "true");
  await expect(liveSummary).toContainText(/Working…\s*8 tools\s*\d+s/);
  await expect(page.getByTestId("tool-rows-hidden")).toHaveText("+2 earlier steps");
  await expect(page.getByTestId("tool-rows")).not.toContainText("Open calendar");
  await expect(page.getByTestId("tool-rows")).toContainText("cal conflicts");
  await expect(page.getByTestId("tool-step-note")).toHaveCount(0);
  // Each row names its call and its result; the last one is still running.
  await expect(page.getByTestId("tool-step").last()).toContainText("Tuesday 2 pm");
  await expect(page.getByTestId("tool-step").last().getByRole("img")).toHaveAccessibleName(
    "Running",
  );
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
  await captureScreenshot(page, testInfo, `default-live-${viewport.name}`);

  // A running row opens to the output it has printed so far.
  await page.getByTestId("tool-step").last().click();
  await expect(page.getByTestId("tool-step-code")).toContainText("Checking 3 calendars");
  await expect(page.getByTestId("tool-step-exit")).toHaveCount(0);
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
  await captureScreenshot(page, testInfo, `default-live-step-open-${viewport.name}`);

  await liveSummary.click();
  await expect(liveSummary).toHaveAttribute("aria-expanded", "false");

  await openThread(page, "done");
  await expect(page.getByTestId("message-bot-bubble")).toContainText(REPLY_TEXT);
  const doneCard = page.getByTestId("tool-activity");
  await expect(doneCard).toHaveCount(1);
  const doneSummary = doneCard.locator("button[aria-expanded]").first();
  await expect(doneSummary).toHaveAttribute("aria-expanded", "false");
  await expect(doneSummary).toContainText(/Done\s*8 tools\s*12s/);
  await captureScreenshot(page, testInfo, `default-done-collapsed-${viewport.name}`);

  await doneSummary.click();
  await expect(doneSummary).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("tool-rows-hidden")).toHaveCount(0);
  await expect(page.getByTestId("tool-rows")).toContainText("Open calendar");
  await expect(page.getByTestId("tool-rows")).toContainText("cal conflicts");
  await expect(page.getByTestId("tool-step-note")).toHaveText(NOTE_TEXT);
  await expect(page.getByTestId("tool-step")).toHaveCount(8);
  await expect(page.getByTestId("tool-step-panel")).toHaveCount(0);
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
  await captureScreenshot(page, testInfo, `default-done-expanded-${viewport.name}`);

  // A shell row opens to its command, output and exit code; a failed one to its error.
  const shellRow = page.getByTestId("tool-step").filter({ hasText: "TZ=Europe/Berlin" });
  await shellRow.click();
  await expect(shellRow).toHaveAttribute("aria-expanded", "true");
  const panel = page.getByTestId("tool-step-panel");
  // The chat's own code block: the command, its output, and the block's copy control.
  await expect(panel.getByTestId("tool-step-code").locator("pre")).toHaveText(
    "$ TZ=Europe/Berlin date -d '2026-08-18 14:00 America/New_York'\nTue Aug 18 20:00:00 CEST 2026\n",
  );
  await expect(panel.getByTestId("tool-step-exit")).toHaveText("exit 0");
  await expect(panel.getByRole("button", { name: "Copy code" })).toHaveCount(1);
  // A structured call shows its arguments instead of a command line.
  const searchRow = page.getByTestId("tool-step").filter({ hasText: "Search inbox" });
  await searchRow.click();
  await expect(
    page.getByTestId("tool-step-code").filter({ hasText: '"query": "from:anna tuesday"' }),
  ).toHaveCount(1);
  const failedRow = page.getByTestId("tool-step").filter({ hasText: "Compare calendars" });
  await expect(failedRow.getByRole("img")).toHaveAccessibleName("Failed");
  await failedRow.click();
  await expect(page.getByTestId("tool-step-error")).toHaveText("Anna's calendar is not shared.");
  await expect(page.getByTestId("tool-step-panel")).toHaveCount(3);
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
  await captureScreenshot(page, testInfo, `default-done-steps-open-${viewport.name}`);
}

test("tool activity shows for live and finished runs when the user turned it on", async ({
  page,
}, testInfo) => {
  await seedToolActivityOn(page);
  await page.setViewportSize(DESKTOP);
  await tourToolActivity(page, testInfo, DESKTOP);
});

// A phone: touch screens lift the row cap that leaves room for the hover rail.
test.describe("on a phone", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: PHONE });

  test("tool activity shows for live and finished runs when the user turned it on", async ({
    page,
  }, testInfo) => {
    await seedToolActivityOn(page);
    await tourToolActivity(page, testInfo, PHONE);
  });
});

test("the settings toggle hides and restores tool activity", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  // Nothing saved leaves the switch off and the cards hidden.
  await page.goto(`${fixture}?view=settings`);
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  const initialToggle = settings.getByTestId("tool-activity-toggle");
  await expect(initialToggle).toBeVisible();
  await expect(initialToggle).not.toBeChecked();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))
    .toBeNull();
  await initialToggle.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "settings-tool-activity-off");

  await openThread(page, "done");
  await expect(page.getByTestId("message-bot-bubble")).toHaveText(REPLY_TEXT);
  await expect(page.getByTestId("tool-activity")).toHaveCount(0);
  await expect(page.getByText(/Done\s*8 tools/)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "off-done");

  await openThread(page, "live");
  await expect(page.getByTestId("tool-activity")).toHaveCount(0);
  await expect(page.getByTestId("tool-activity-line")).toHaveCount(0);
  await expect(page.getByTestId("message-bot-bubble")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "off-live");

  await setToggle(page, true);
  await captureScreenshot(page, testInfo, "settings-tool-activity-on");

  await openThread(page, "done");
  await expect(page.getByTestId("tool-activity")).toHaveCount(1);
  await expect(
    page.getByTestId("tool-activity").locator("button[aria-expanded]").first(),
  ).toContainText(/Done\s*8 tools/);
  await captureScreenshot(page, testInfo, "on-again-done");
});
