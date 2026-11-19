import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

test("a day calendar fits a phone-width page while a week calendar still scrolls", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `pages-day-calendar-${Date.now()}@rakazo.test`,
    "password12",
    "Calendar Reader",
  );
  await completeOnboarding(page);
  await page.setViewportSize({ width: 390, height: 844 });

  const title = "Calendar on a phone";
  const source = `export default function CalendarPage() {
    const events = [{ start: 9.25, end: 10.25, title: "Design review" }];
    return <Page title="Calendar on a phone">
      <Section heading="Day">
        <DayView start={9} end={11} events={events} />
      </Section>
      <Section heading="Day (RTL)">
        <div dir="rtl"><DayView start={9} end={11} events={events} /></div>
      </Section>
      <Section heading="Week">
        <WeekView week="2026-11-09" start={9} end={11} events={[
          { date: "2026-11-09", start: 9, end: 10, title: "Monday review" },
          { date: "2026-11-15", start: 9, end: 10, title: "Sunday review" }
        ]} />
      </Section>
    </Page>;
  }`;
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill(`call save_page with ${JSON.stringify({ title, source })}\nthen say Done.`);
  await composer.press("Enter");
  const card = page.getByTestId("page-card");
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await card.getByRole("button", { name: `Open ${title}` }).click();

  const frame = page
    .locator(`iframe[title="${title}"]`)
    .last()
    .contentFrame()
    .locator("iframe#preview")
    .contentFrame();
  const days = frame.locator(".rk-cal-timed:not(.rk-cal-week)");
  const week = frame.locator(".rk-cal-week");
  await expect(days).toHaveCount(2);
  await expect(week.locator(".rk-cal-column")).toHaveCount(7);
  const layout = await frame.locator(".rk-page").evaluate((root) => {
    const rect = (el: Element) => el.getBoundingClientRect();
    const days = [...root.querySelectorAll(".rk-cal-timed:not(.rk-cal-week)")].map((day) => {
      const box = rect(day);
      const axis = rect(day.querySelector(".rk-cal-hours span")!);
      const event = rect(day.querySelector(".rk-cal-event")!);
      return {
        direction: getComputedStyle(day).direction,
        overflow: day.scrollWidth - day.clientWidth,
        axisVisible: axis.left >= box.left && axis.right <= box.right,
        eventVisible: event.left >= box.left && event.right <= box.right,
      };
    });
    const week = root.querySelector(".rk-cal-week")!;
    const heads = [...week.querySelectorAll(".rk-cal-head")].map(rect);
    const columns = [...week.querySelectorAll(".rk-cal-column")].map(rect);
    return {
      phoneWidth: matchMedia("(max-width:640px)").matches,
      days,
      weekOverflow: week.scrollWidth - week.clientWidth,
      heads: heads.map((head) => head.x),
      columns: columns.map((column) => ({ x: column.x, y: column.y })),
    };
  });
  expect(layout.phoneWidth).toBe(true);
  expect(layout.days.map((day) => day.direction)).toEqual(["ltr", "rtl"]);
  for (const day of layout.days) {
    expect(day.overflow).toBeLessThanOrEqual(1);
    expect(day.axisVisible).toBe(true);
    expect(day.eventVisible).toBe(true);
  }
  expect(layout.weekOverflow).toBeGreaterThan(0);
  expect(layout.heads).toHaveLength(7);
  expect(layout.columns).toHaveLength(7);
  for (const [index, column] of layout.columns.entries()) {
    expect(Math.abs(column.x - layout.heads[index]!)).toBeLessThanOrEqual(1);
    expect(column.y).toBeCloseTo(layout.columns[0]!.y, 0);
  }
  await captureScreenshot(page, testInfo, "page-day-calendar-phone");
});
