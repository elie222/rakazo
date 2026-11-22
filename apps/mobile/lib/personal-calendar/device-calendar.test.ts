import type { CalendarOperation } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareDeviceCalendar } from "./device-calendar";

const native = vi.hoisted(() => ({
  platform: { OS: "android" },
  locale: new Intl.DateTimeFormat().resolvedOptions().locale,
  apple: { calendars: vi.fn(), createReminder: vi.fn() },
  alert: vi.fn(),
  getCalendars: vi.fn(),
  getCalendarPermissions: vi.fn(),
  getRemindersPermissions: vi.fn(),
  requestCalendarPermissions: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: native.platform, Alert: { alert: native.alert } }));
vi.mock("../i18n/i18n", () => ({ dateLocaleForUi: () => native.locale }));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => native.apple }));
vi.mock("expo-calendar", () => ({
  EntityTypes: { EVENT: "event" },
  Frequency: { DAILY: "daily", WEEKLY: "weekly" },
  getCalendars: native.getCalendars,
  getCalendarPermissions: native.getCalendarPermissions,
  getRemindersPermissions: native.getRemindersPermissions,
  requestCalendarPermissions: native.requestCalendarPermissions,
}));

const calendar = {
  source: "device",
  accountId: JSON.stringify(["local", "Owner"]),
  calendarId: "12",
} as const;
const event: Extract<CalendarOperation, { action: "create_calendar_event" }> = {
  action: "create_calendar_event",
  input: {
    calendar,
    event: {
      title: "Example",
      timing: { allDay: true, start: "2026-11-10", end: "2026-11-11", timeZone: "Europe/Paris" },
      recurrence: { frequency: "daily", interval: 2, count: 3 },
    },
  },
};

const destination = () => ({
  id: calendar.calendarId,
  source: { type: "local", name: "Owner" },
  title: "Selected calendar",
  allowsModifications: true,
  createEvent: vi.fn(async () => ({ calendarId: calendar.calendarId, id: "saved" })),
});

const hostLocale = native.locale;
const otherLocale = hostLocale.startsWith("de") ? "en-US" : "de-DE";

afterEach(() => {
  vi.resetAllMocks();
  native.platform.OS = "android";
  native.locale = hostLocale;
});

async function cancelledEventPreview(timing: typeof event.input.event.timing) {
  const target = destination();
  native.getCalendarPermissions.mockResolvedValue({ granted: true });
  native.getCalendars.mockResolvedValue([target]);
  native.alert.mockImplementation((_title, _message, actions) => actions[0].onPress());
  const prepared = await prepareDeviceCalendar(
    { ...event, input: { ...event.input, event: { ...event.input.event, timing } } },
    () => true,
  );
  expect(prepared).toEqual({ status: "cancelled" });
  expect(target.createEvent).not.toHaveBeenCalled();
  return native.alert.mock.calls[0]?.[1];
}

describe("device calendar confirmation previews", () => {
  it("shows an ordinary timed range in the app locale and event time zone", async () => {
    native.locale = otherLocale;
    const start = "2026-11-02T14:30:00Z";
    const end = "2026-11-02T15:45:00Z";
    const timeZone = "America/New_York";
    const date = new Intl.DateTimeFormat(otherLocale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    });
    const message = await cancelledEventPreview({ allDay: false, start, end, timeZone });
    expect(message.split("\n")).toContain(
      `${date.format(new Date(start))} – ${date.format(new Date(end))}`,
    );
    expect(message.split("\n")).toContain(timeZone);
  });

  it.each([
    ["America/New_York", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "GMT-4", "GMT-5"],
    ["Australia/Lord_Howe", "2026-04-04T14:45:00Z", "2026-04-04T15:15:00Z", "GMT+11", "GMT+10:30"],
  ])("distinguishes repeated wall times in %s", async (timeZone, start, end, first, second) => {
    native.locale = "en-US";
    const message = await cancelledEventPreview({ allDay: false, start, end, timeZone });
    const range = message.split("\n").find((line: string) => line.includes(" – "));
    expect(range?.split(" – ")).toEqual([
      expect.stringContaining(first),
      expect.stringContaining(second),
    ]);
    expect(message.split("\n")).toContain(timeZone);
  });

  it("keeps an ordinary event within one minute as a single label", async () => {
    const start = "2026-11-02T14:30:01Z";
    const end = "2026-11-02T14:30:58Z";
    const timeZone = "America/New_York";
    const date = new Intl.DateTimeFormat(hostLocale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    });
    const message = await cancelledEventPreview({ allDay: false, start, end, timeZone });
    expect(message.split("\n")).toContain(date.format(new Date(start)));
    expect(message).not.toContain(" – ");
  });

  it("shows an iOS reminder due time in the app locale and reminder time zone", async () => {
    native.platform.OS = "ios";
    native.locale = otherLocale;
    native.getRemindersPermissions.mockResolvedValue({ granted: true });
    native.apple.calendars.mockResolvedValue([
      { ...calendar, name: "Selected list", accountName: "Owner", writable: true },
    ]);
    native.alert.mockImplementation((_title, _message, actions) => actions[0].onPress());
    const due = { at: "2026-11-02T09:30:00Z", timeZone: "Asia/Tokyo" };
    const prepared = await prepareDeviceCalendar(
      {
        action: "create_reminder",
        input: {
          list: { accountId: calendar.accountId, listId: calendar.calendarId },
          title: "Synthetic reminder",
          due,
        },
      },
      () => true,
    );
    expect(prepared).toEqual({ status: "cancelled" });
    const date = new Intl.DateTimeFormat(otherLocale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: due.timeZone,
    });
    expect(native.alert.mock.calls[0]?.[1].split("\n")).toContain(date.format(new Date(due.at)));
    expect(native.alert.mock.calls[0]?.[1].split("\n")).toContain(due.timeZone);
    expect(native.alert.mock.calls[0]?.[1]).toContain("Selected list");
    expect(native.apple.createReminder).not.toHaveBeenCalled();
  });
});

describe("Android calendar writes", () => {
  it("handles denied permissions without reading calendar data", async () => {
    native.getCalendarPermissions.mockResolvedValue({ granted: false, canAskAgain: false });
    expect(await prepareDeviceCalendar(event, () => true)).toEqual({ status: "denied" });
    expect(native.getCalendars).not.toHaveBeenCalled();
    expect(native.alert).not.toHaveBeenCalled();
  });

  it("confirms the named calendar and writes exclusive dates and recurrence there", async () => {
    const target = destination();
    const other = { ...destination(), id: "99", title: "Default", isPrimary: true };
    native.getCalendarPermissions.mockResolvedValue({ granted: true });
    native.getCalendars.mockResolvedValue([other, target]);
    native.alert.mockImplementation((_title, _message, actions) => actions[1].onPress());
    const prepared = await prepareDeviceCalendar(event, () => true);
    const message = native.alert.mock.calls[0]?.[1];
    expect(message).toContain("Selected calendar");
    const date = new Intl.DateTimeFormat(hostLocale, { dateStyle: "medium", timeZone: "UTC" });
    expect(message.split("\n")).toContain(date.format(new Date("2026-11-10")));
    expect(message).not.toContain(date.format(new Date("2026-11-11")));
    expect(message.split("\n")).toContain("All day");
    expect("perform" in prepared).toBe(true);
    if ("perform" in prepared) {
      expect(await prepared.perform()).toEqual({ status: "ok", data: { id: "saved", calendar } });
    }
    expect(target.createEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        allDay: true,
        startDate: new Date("2026-11-10"),
        endDate: new Date("2026-11-11"),
        timeZone: "UTC",
        recurrenceRule: { frequency: "daily", interval: 2, occurrence: 3 },
      }),
    );
    expect(other.createEvent).not.toHaveBeenCalled();
  });

  it("refuses if the calendar disappears or changes accounts before saving", async () => {
    const target = destination();
    const replaced = { ...target, source: { type: "synced", name: "Another account" } };
    native.getCalendarPermissions.mockResolvedValue({ granted: true });
    native.getCalendars.mockResolvedValueOnce([target]).mockResolvedValueOnce([replaced]);
    native.alert.mockImplementation((_title, _message, actions) => actions[1].onPress());
    const prepared = await prepareDeviceCalendar(event, () => true);
    expect("perform" in prepared).toBe(true);
    if ("perform" in prepared) expect(await prepared.perform()).toEqual({ status: "unavailable" });
    expect(target.createEvent).not.toHaveBeenCalled();
  });

  it("does not prepare a save after cancellation", async () => {
    const target = destination();
    native.getCalendarPermissions.mockResolvedValue({ granted: true });
    native.getCalendars.mockResolvedValue([target]);
    native.alert.mockImplementation((_title, _message, actions) => actions[0].onPress());
    const prepared = await prepareDeviceCalendar(event, () => true);
    expect(prepared).toEqual({ status: "cancelled" });
    expect(target.createEvent).not.toHaveBeenCalled();
  });
});
