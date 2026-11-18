import type { MeetingJoinRequest } from "./meetings.js";

export interface MeetingCalendarEvent {
  id: string;
  calendarId: string;
  /** Stable within a calendar. Distinct events may share their meeting link. */
  seriesId: string | null;
  title: string;
  startsAt: Date;
  endsAt: Date;
  meetingUrl: string | null;
  cancelled: boolean;
  declined: boolean;
}

export type MeetingCalendarChange =
  | { kind: "events"; calendarId: string; since: Date }
  | { kind: "connection"; calendarId: string };

export interface MeetingCalendarProvider {
  readonly id: string;
  readonly calendarLabel: string;
  authorizationUrl(input: { state: string; challenge: string; redirectUri: string }): string;
  connect(
    input: {
      connectionId: string;
      code: string;
      verifier: string;
      redirectUri: string;
    },
    signal: AbortSignal,
  ): Promise<{ calendarId: string }>;
  status(
    calendarId: string,
    signal: AbortSignal,
  ): Promise<"connecting" | "connected" | "disconnected">;
  disconnect(calendarId: string, signal: AbortSignal): Promise<void>;
  listEvents(
    calendarId: string,
    filter: { since?: Date; upcoming?: Date },
    signal: AbortSignal,
  ): AsyncIterable<MeetingCalendarEvent>;
  getEvent(eventId: string, signal: AbortSignal): Promise<MeetingCalendarEvent | null>;
  schedule(
    eventId: string,
    scheduleKey: string,
    startsAt: Date,
    request: MeetingJoinRequest,
    signal: AbortSignal,
  ): Promise<string>;
  unschedule(eventId: string, signal: AbortSignal): Promise<void>;
  verifyChange(body: string, headers: Headers): MeetingCalendarChange | "ignored" | null;
}
