import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { AppBootstrap, Me, RpcOutput } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

test("a recurring meeting is scheduled and one occurrence can be skipped", async ({
  page,
}, testInfo) => {
  if (process.env.MEETING_PROVIDER !== "emulator") await calendarFixture(page);
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

/** CI can exercise the calendar UI without configuring a meeting provider. */
async function calendarFixture(page: Page) {
  let connected = false;
  const now = Date.UTC(2026, 10, 18, 14);
  const events: RpcOutput<"meetingCalendar/upcoming">["events"] = [1, 2].map((week) => ({
    id: `design-review-${week}`,
    title: "Design review",
    platform: "google_meet",
    startsAt: now + week * 7 * 24 * 60 * 60_000,
    endsAt: now + week * 7 * 24 * 60 * 60_000 + 30 * 60_000,
    recurring: true,
    selection: "none",
    scheduled: false,
  }));
  const reply = (route: Route, json?: unknown) => route.fulfill({ json: { json } });
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const data: { json?: AppBootstrap } = await response.json();
    if (data.json) data.json.me.meetingsEnabled = true;
    await route.fulfill({ response, json: data });
  });
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const data: { json?: Me } = await response.json();
    if (data.json) data.json.meetingsEnabled = true;
    await route.fulfill({ response, json: data });
  });
  await page.route("**/rpc/meetings/list", (route) =>
    reply(route, { enabled: true, meetings: [] }),
  );
  await page.route("**/rpc/meetingCalendar/upcoming", (route) =>
    reply(route, {
      available: true,
      connected,
      calendarLabel: "Google Calendar",
      events: connected ? events : [],
    }),
  );
  await page.route("**/rpc/meetingCalendar/begin", (route) => {
    connected = true;
    const authorizationUrl = new URL("/app", route.request().url()).href;
    return reply(route, { authorizationUrl, state: "offline" });
  });
  await page.route("**/rpc/meetingCalendar/select", (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      json: { eventId: "design-review-1", scope: "series" },
    });
    for (const event of events) {
      event.selection = "series";
      event.scheduled = true;
    }
    return reply(route);
  });
  await page.route("**/rpc/meetingCalendar/skip", (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ json: { eventId: "design-review-1" } });
    const first = events[0]!;
    first.selection = "skipped";
    first.scheduled = false;
    return reply(route);
  });
}
