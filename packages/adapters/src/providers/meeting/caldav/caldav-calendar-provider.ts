import { createHash } from "node:crypto";
import type {
  MeetingCalendarAccount,
  MeetingCalendarAccountStore,
  MeetingCalendarConnectionState,
  MeetingCalendarEvent,
  MeetingCalendarProvider,
  MeetingCalendarRelease,
  MeetingJoinRequest,
} from "@rakazo/adapter-kit";
import {
  MeetingCalendarConnectRejected,
  MeetingCalendarConnectUnavailable,
} from "@rakazo/adapter-kit";
import { ClientError, sliceWellFormed } from "@rakazo/core";
import { z } from "zod";
import { ConnectorRedirectError } from "../../../mcp/remote-mcp.js";
import { parseMeetingUrl } from "../../../meetings/meeting-link.js";
import type { CalDavAccount } from "./caldav-client.js";
import { CalDavAuthError, CalDavClient, CalDavProtocolError } from "./caldav-client.js";
import type { ICalOccurrence } from "./ical-events.js";
import { expandCalendarObject } from "./ical-events.js";

/** Reserves and releases the meeting participant for a Rakazo session. */
export interface ScheduledMeetingBots {
  schedule(request: MeetingJoinRequest, joinAt: Date, signal: AbortSignal): Promise<string>;
  cancel(sessionId: string, externalId: string | null, signal: AbortSignal): Promise<void>;
}

export type CalDavFetch = (input: URL, init: RequestInit) => Promise<Response>;

export interface CalDavCalendarOptions {
  accounts: MeetingCalendarAccountStore;
  bots: ScheduledMeetingBots;
  /** A fetch that refuses private addresses unless the deployment allows them. */
  fetch: CalDavFetch;
  now?: () => Date;
}

const DEFAULT_LOOKAHEAD_MS = 14 * 24 * 60 * 60_000;
const MAX_EVENT_ID_LENGTH = 256;
const sealedAccount = z.object({
  serverUrl: z.url(),
  username: z.string().min(1),
  password: z.string().min(1),
  homeUrl: z.url(),
});
const encodedEvent = z.tuple([z.string().min(1), z.string().nullable()]);

function digest(...parts: string[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
}

function isMeetingLink(candidate: string) {
  try {
    parseMeetingUrl(candidate);
    return true;
  } catch (error) {
    if (error instanceof ClientError) return false;
    throw error;
  }
}

/** The member's own addresses, so a declined invitation is not scheduled. */
function attendeeEmails(account: CalDavAccount) {
  return account.username.includes("@") ? [account.username] : [];
}

/**
 * Reads meetings from a CalDAV calendar account, such as iCloud, Fastmail or Nextcloud, and
 * reserves meeting participants through the meeting provider. CalDAV servers send no change
 * notifications, so the calendar service re-reads each account on `refreshIntervalMs`.
 */
export class CalDavCalendarProvider implements MeetingCalendarProvider {
  readonly id = "caldav";
  readonly calendarLabel = "CalDAV calendar";
  readonly signIn = "password" as const;
  readonly refreshIntervalMs = 10 * 60_000;
  readonly schedulesPerSession = true;

  constructor(private readonly options: CalDavCalendarOptions) {}

  authorizationUrl(): string {
    throw new MeetingCalendarConnectUnavailable("CalDAV calendars connect with an app password.");
  }

  connect(): Promise<{ calendarId: string }> {
    throw new MeetingCalendarConnectUnavailable("CalDAV calendars connect with an app password.");
  }

  async verifyAccount(input: MeetingCalendarAccount, signal: AbortSignal): Promise<string> {
    const serverUrl = URL.parse(input.serverUrl.trim());
    if (serverUrl?.protocol !== "https:" || serverUrl.username || serverUrl.password) {
      throw new MeetingCalendarConnectRejected("Enter the calendar server's HTTPS address.");
    }
    const account: CalDavAccount = {
      serverUrl: serverUrl.href,
      username: input.username.trim(),
      password: input.password,
    };
    try {
      const client = this.client(account);
      const homeUrl = await client.discoverHome(signal);
      const calendars = await this.client({ ...account, homeUrl }).calendars(signal);
      if (!calendars.length) {
        throw new MeetingCalendarConnectRejected("This account has no event calendars.");
      }
      return JSON.stringify({ ...account, homeUrl } satisfies z.infer<typeof sealedAccount>);
    } catch (error) {
      if (error instanceof MeetingCalendarConnectRejected) throw error;
      if (error instanceof CalDavAuthError) {
        throw new MeetingCalendarConnectRejected(
          "The calendar server refused the username or app password.",
        );
      }
      if (error instanceof CalDavProtocolError || error instanceof ConnectorRedirectError) {
        throw new MeetingCalendarConnectRejected(
          "Rakazo could not find calendars at that address. Enter the server's CalDAV address.",
        );
      }
      throw new MeetingCalendarConnectUnavailable("Could not reach the calendar server.", {
        cause: error,
      });
    }
  }

  async getConnection(
    calendarId: string,
    signal: AbortSignal,
  ): Promise<MeetingCalendarConnectionState | null> {
    const account = await this.account(calendarId, signal);
    if (!account) return null;
    try {
      await this.client(account).calendars(signal);
    } catch (error) {
      // A revoked app password disconnects the calendar; other failures retry later.
      if (error instanceof CalDavAuthError) return { calendarId, status: "disconnected" };
      throw error;
    }
    return { calendarId, status: "connected" };
  }

  async findConnection() {
    // Connections are bound to their calendar when they are created.
    return null;
  }

  async disconnect() {
    // The sealed account is stored with the connection and removed with it.
  }

  async *listEvents(
    calendarId: string,
    filter: { since?: Date; upcoming?: Date; startsThrough?: Date },
    signal: AbortSignal,
  ): AsyncIterable<MeetingCalendarEvent> {
    const account = await this.account(calendarId, signal);
    if (!account) return;
    const from = filter.upcoming ?? this.now();
    const window = {
      from,
      through: filter.startsThrough ?? new Date(from.getTime() + DEFAULT_LOOKAHEAD_MS),
    };
    const client = this.client(account);
    for (const calendar of await client.calendars(signal)) {
      for (const object of await client.events(calendar.url, window, signal)) {
        for (const occurrence of expandCalendarObject(
          object.data,
          window,
          isMeetingLink,
          attendeeEmails(account),
        )) {
          yield this.toEvent(calendarId, calendar.url, object.url, occurrence);
        }
      }
    }
  }

  async getEvent(eventId: string, signal: AbortSignal): Promise<MeetingCalendarEvent | null> {
    const decoded = this.decodeEventId(eventId);
    if (!decoded) return null;
    const { calendarId } = decoded;
    if (decoded.kind === "digest") {
      // Rare: the object address was too long to carry in the ID.
      for await (const event of this.listEvents(calendarId, {}, signal)) {
        if (event.id === eventId) return event;
      }
      return null;
    }
    const account = await this.account(calendarId, signal);
    if (!account) return null;
    const client = this.client(account);
    const objectUrl = URL.parse(decoded.objectUrl);
    const calendars = await client.calendars(signal);
    const calendar = calendars.find(
      ({ url }) =>
        objectUrl && objectUrl.origin === new URL(url).origin && objectUrl.href.startsWith(url),
    );
    if (!calendar || !objectUrl) return null;
    const data = await client.object(objectUrl.href, signal);
    if (!data) return null;
    // Look a year either side so an occurrence moved far from its slot is still found.
    const year = 366 * 24 * 60 * 60_000;
    const anchor = decoded.recurrenceId ? Date.parse(decoded.recurrenceId) : this.now().getTime();
    const occurrences = expandCalendarObject(
      data,
      { from: new Date(anchor - year), through: new Date(anchor + year) },
      isMeetingLink,
      attendeeEmails(account),
    );
    const match = occurrences.find(
      (occurrence) => (occurrence.recurrenceId ?? null) === decoded.recurrenceId,
    );
    return match ? this.toEvent(calendarId, calendar.url, objectUrl.href, match) : null;
  }

  eventCalendarId(eventId: string) {
    return this.decodeEventId(eventId)?.calendarId ?? null;
  }

  async schedule(
    _eventId: string,
    _scheduleKey: string,
    startsAt: Date,
    request: MeetingJoinRequest,
    signal: AbortSignal,
  ): Promise<string> {
    // The calendar service shares one session among the calendars that book the same
    // meeting, so the session alone identifies the participant to reserve.
    return this.options.bots.schedule(request, startsAt, signal);
  }

  async unschedule(_eventId: string, signal: AbortSignal, release?: MeetingCalendarRelease) {
    if (!release?.lastBooking) return;
    await this.options.bots.cancel(release.sessionId, release.externalId, signal);
  }

  verifyChange() {
    // CalDAV servers do not sign change notifications; events are re-read on a schedule.
    return null;
  }

  private toEvent(
    calendarId: string,
    calendarUrl: string,
    objectUrl: string,
    occurrence: ICalOccurrence,
  ): MeetingCalendarEvent {
    return {
      id: this.eventId(calendarId, objectUrl, occurrence.recurrenceId),
      calendarId,
      seriesId: occurrence.recurring ? digest(calendarUrl, occurrence.uid) : null,
      title: sliceWellFormed(occurrence.title, 300),
      startsAt: occurrence.startsAt,
      endsAt: occurrence.endsAt,
      meetingUrl: occurrence.meetingUrl,
      cancelled: occurrence.cancelled,
      declined: occurrence.declined,
    };
  }

  private eventId(calendarId: string, objectUrl: string, recurrenceId: string | null) {
    const encoded = Buffer.from(JSON.stringify([objectUrl, recurrenceId])).toString("base64url");
    const id = `${calendarId}.o.${encoded}`;
    return id.length <= MAX_EVENT_ID_LENGTH
      ? id
      : `${calendarId}.d.${digest(objectUrl, recurrenceId ?? "")}`;
  }

  private decodeEventId(eventId: string) {
    const match = /^([0-9a-f-]{36})\.([od])\.([\w-]+)$/u.exec(eventId);
    if (!match) return null;
    const [, calendarId, kind, value] = match;
    if (kind === "d") return { kind: "digest" as const, calendarId: calendarId! };
    try {
      const [objectUrl, recurrenceId] = encodedEvent.parse(
        JSON.parse(Buffer.from(value!, "base64url").toString("utf8")),
      );
      return { kind: "object" as const, calendarId: calendarId!, objectUrl, recurrenceId };
    } catch {
      return null;
    }
  }

  private async account(calendarId: string, signal: AbortSignal) {
    const sealed = await this.options.accounts.load(calendarId, signal);
    if (!sealed) return null;
    return sealedAccount.parse(JSON.parse(sealed));
  }

  private client(account: CalDavAccount) {
    return new CalDavClient(account, this.options.fetch);
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }
}
