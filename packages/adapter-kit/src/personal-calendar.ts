import type { CalendarOperation, CalendarResponse } from "@rakazo/contracts";
import type { AdapterContext, ConnectedConnector } from "./types.js";

export type ConnectedCalendarOperation = Extract<
  CalendarOperation,
  {
    action: "list_calendars" | "list_calendar_events" | "create_calendar_event";
  }
>;

/** The caller has resolved an exact connected account in the run's Space. */
export interface ConnectedCalendarProvider {
  supportsCalendar(connection: ConnectedConnector): boolean;
  calendar(
    connection: ConnectedConnector,
    operation: ConnectedCalendarOperation,
    idempotencyKey: string,
    context: AdapterContext,
  ): Promise<CalendarResponse>;
}
