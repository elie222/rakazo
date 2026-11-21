import type { CalendarOperation } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareDeviceCalendar } from "./device-calendar";

const native = vi.hoisted(() => ({
  platform: { OS: "android" },
  alert: vi.fn(),
  getCalendars: vi.fn(),
  getCalendarPermissions: vi.fn(),
  requestCalendarPermissions: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: native.platform, Alert: { alert: native.alert } }));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("expo-calendar", () => ({
  EntityTypes: { EVENT: "event" },
  Frequency: { DAILY: "daily", WEEKLY: "weekly" },
  getCalendars: native.getCalendars,
  getCalendarPermissions: native.getCalendarPermissions,
  requestCalendarPermissions: native.requestCalendarPermissions,
}));

const calendar = {
  source: "device",
  accountId: JSON.stringify(["local", "Owner"]),
  calendarId: "12",
} as const;
const event: CalendarOperation = {
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

afterEach(() => vi.resetAllMocks());

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
    expect(native.alert.mock.calls[0]?.[1]).toContain("Selected calendar");
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
