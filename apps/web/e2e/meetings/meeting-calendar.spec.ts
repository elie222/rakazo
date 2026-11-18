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

  const upcomingRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/meetingCalendar/upcoming")) {
      upcomingRequests.push(request.url());
    }
  });
  const openSchedule = async () => {
    const initial = upcomingRequests.length;
    await page.getByRole("button", { name: "Meetings", exact: true }).click();
    await expect(page.getByRole("button", { name: "Auto-join" })).toBeVisible();
    expect(upcomingRequests).toHaveLength(initial);
    await page.getByRole("button", { name: "Auto-join" }).click();
  };
  // Drop status requests, then let the user's retry hit the real API and emulator.
  const statusRoute = "**/rpc/meetingCalendar/status";
  await page.route(statusRoute, (route) => route.abort());
  await openSchedule();
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeVisible();
  expect(upcomingRequests).toHaveLength(0);
  await captureScreenshot(page, testInfo, "meeting-calendar-status-retry");
  await page.unroute(statusRoute);
  await retry.click();
  await page.getByRole("button", { name: "Connect Google Calendar" }).click();
  const meetings = page.getByRole("dialog", { name: "Meetings" });
  await expect(meetings.getByRole("heading", { name: "Upcoming meetings" })).toBeVisible();
  await captureScreenshot(page, testInfo, "meeting-calendar-return-from-sign-in");

  const events = page.getByRole("listitem").filter({ hasText: "Design review" });
  const first = events.first();
  const second = events.last();
  const sharingNotice = page.getByText(
    "Choosing a join option shares transcripts with this Space.",
  );
  await expect(sharingNotice).toHaveCount(0);
  await first.getByRole("button", { name: /^Design review,/ }).click();
  await expect(sharingNotice).toBeVisible();
  await captureScreenshot(page, testInfo, "meeting-calendar-sharing-notice");
  await page.getByRole("menuitem", { name: "Join this series" }).click();
  await expect(first.getByRole("button", { name: /^Design review,/ })).toHaveText("Scheduled");
  await expect(second.getByRole("button", { name: /^Design review,/ })).toHaveText("Scheduled");

  await first.getByRole("button", { name: /^Design review,/ }).click();
  await expect(sharingNotice).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Skip this meeting" }).click();
  await expect(first.getByRole("button", { name: /^Design review,/ })).toHaveText("Skipped");
  await expect(second.getByRole("button", { name: /^Design review,/ })).toHaveText("Scheduled");
  await expect(page.getByText("Meeting ended", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "meeting-calendar-series-and-skip");

  const openDisconnect = async () => {
    await page.getByRole("button", { name: "Calendar options" }).click();
    await page.getByRole("menuitem", { name: "Disconnect calendar" }).click();
  };
  const confirmation = page.getByRole("alertdialog", { name: "Disconnect calendar?" });
  await openDisconnect();
  await expect(confirmation).toBeVisible();
  await captureScreenshot(page, testInfo, "meeting-calendar-disconnect-confirmation");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(second.getByRole("button", { name: /^Design review,/ })).toHaveText("Scheduled");
  await openDisconnect();
  await confirmation.getByRole("button", { name: "Disconnect calendar" }).click();
  await expect(page.getByRole("button", { name: "Connect Google Calendar" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Meetings", exact: true })).toBeVisible();
  await expect(meetings).toHaveCount(0);
});
