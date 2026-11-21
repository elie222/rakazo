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

export interface MeetingCalendarConnectionState {
  calendarId: string;
  connectionRef?: string;
  status: "connecting" | "connected" | "disconnected";
}

/** The sign-in failed before a provider calendar could have been created. */
export class MeetingCalendarConnectRejected extends Error {}

/** Sign-in infrastructure failed before any provider calendar mutation. */
export class MeetingCalendarConnectUnavailable extends Error {}

/** The provider definitively rejected this event's reservation. */
export class MeetingCalendarScheduleRejected extends Error {}

export interface MeetingCalendarProvider {
  readonly id: string;
  readonly calendarLabel: string;
  authorizationUrl(input: { state: string; challenge: string; redirectUri: string }): string;
  connect(
    input: {
      connectionRef: string;
      code: string;
      verifier: string;
      redirectUri: string;
    },
    signal: AbortSignal,
  ): Promise<{ calendarId: string }>;
  getConnection(
    calendarId: string,
    signal: AbortSignal,
  ): Promise<MeetingCalendarConnectionState | null>;
  findConnection(
    connectionRef: string,
    createdSince: Date,
    signal: AbortSignal,
  ): Promise<MeetingCalendarConnectionState | null>;
  disconnect(calendarId: string, signal: AbortSignal): Promise<void>;
  listEvents(
    calendarId: string,
    filter: { since?: Date; upcoming?: Date; startsThrough?: Date },
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
