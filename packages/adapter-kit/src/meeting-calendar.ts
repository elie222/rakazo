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

/** Sign-in details for a calendar account reached with a password rather than OAuth. */
export interface MeetingCalendarAccount {
  serverUrl: string;
  username: string;
  password: string;
}

/** Reads the account sealed for a connected calendar, by its provider calendar ID. */
export interface MeetingCalendarAccountStore {
  load(calendarId: string, signal: AbortSignal): Promise<string | null>;
}

/** The booking a calendar event releases, for providers that schedule one participant per session. */
export interface MeetingCalendarRelease {
  sessionId: string;
  externalId: string | null;
  /** No other calendar event still needs this session's participant. */
  lastBooking: boolean;
}

export interface MeetingCalendarProvider {
  readonly id: string;
  readonly calendarLabel: string;
  /**
   * `oauth` (the default) connects through `authorizationUrl` and `connect`. `password`
   * connects through `verifyAccount` with a server address, username and app password.
   */
  readonly signIn?: "oauth" | "password";
  /** How often to re-read events when the provider sends no change notifications. */
  readonly refreshIntervalMs?: number;
  /**
   * The provider reserves one participant per Rakazo session instead of per calendar event.
   * `unschedule` then receives the release details, and a disconnect releases each booking
   * before the calendar is removed.
   */
  readonly schedulesPerSession?: boolean;
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
  /** The calendar an event ID belongs to, when the ID carries it, checked before any lookup. */
  eventCalendarId?(eventId: string): string | null;
  schedule(
    eventId: string,
    scheduleKey: string,
    startsAt: Date,
    request: MeetingJoinRequest,
    signal: AbortSignal,
  ): Promise<string>;
  unschedule(eventId: string, signal: AbortSignal, release?: MeetingCalendarRelease): Promise<void>;
  /**
   * Password sign-in only: checks the account and returns the details to seal for it.
   * Throws MeetingCalendarConnectRejected when the server refuses them.
   */
  verifyAccount?(account: MeetingCalendarAccount, signal: AbortSignal): Promise<string>;
  verifyChange(body: string, headers: Headers): MeetingCalendarChange | "ignored" | null;
}
