import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

test("a recurring meeting is scheduled and one occurrence can be skipped", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.MEETING_PROVIDER !== "emulator",
    "Set MEETING_PROVIDER=emulator to exercise the calendar provider and its OAuth flow.",
  );
  await signup(page, `calendar-${Date.now()}@rakazo.test`, "password12", "Calendar Tester");
  await completeOnboarding(page);

  const openSchedule = async () => {
    await page.getByRole("button", { name: "Meetings", exact: true }).click();
    await page.getByRole("button", { name: "Auto-join" }).click();
  };
  await openSchedule();
  await page.getByRole("button", { name: "Connect Google Calendar" }).click();
  await expect(page.getByRole("dialog", { name: "Meetings" })).toHaveCount(0);
  await openSchedule();

  const events = page.getByRole("listitem").filter({ hasText: "Design review" });
  const first = events.first();
  const second = events.last();
  await first.getByRole("button", { name: "Schedule for Design review" }).click();
  await page.getByRole("menuitem", { name: "Join this series" }).click();
  await expect(first.getByRole("button", { name: "Schedule for Design review" })).toHaveText(
    "Scheduled",
  );
  await expect(second.getByRole("button", { name: "Schedule for Design review" })).toHaveText(
    "Scheduled",
  );

  await first.getByRole("button", { name: "Schedule for Design review" }).click();
  await page.getByRole("menuitem", { name: "Skip this meeting" }).click();
  await expect(first.getByRole("button", { name: "Schedule for Design review" })).toHaveText(
    "Skipped",
  );
  await expect(second.getByRole("button", { name: "Schedule for Design review" })).toHaveText(
    "Scheduled",
  );
  await captureScreenshot(page, testInfo, "meeting-calendar-series-and-skip");
});
