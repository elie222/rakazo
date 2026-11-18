import type {
  MeetingCalendarEvent,
  MeetingCalendarProvider,
  MeetingJoinRequest,
} from "@rakazo/adapter-kit";
import { RetryJobLaterError } from "@rakazo/adapter-kit";
import { cancelResponseBody, parseRetryAfter, readBoundedJsonResponse } from "@rakazo/core";
import { z } from "zod";
import { buildRecallBotConfig } from "./recall-meeting.js";

const calendarSchema = z.object({
  id: z.string().min(1),
  status_changes: z.array(
    z.object({
      created_at: z.iso.datetime({ offset: true }),
      status: z.enum(["connecting", "connected", "disconnected"]),
    }),
  ),
});

const eventSchema = z.object({
  id: z.string().min(1),
  calendar_id: z.string().min(1),
  start_time: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  end_time: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  meeting_url: z.string().nullish(),
  is_deleted: z.boolean(),
  raw: z
    .object({
      summary: z.string().optional(),
      recurringEventId: z.string().optional(),
      status: z.string().optional(),
      attendees: z
        .array(z.object({ self: z.boolean().optional(), responseStatus: z.string().optional() }))
        .optional(),
    })
    .nullish(),
});

const eventPage = z.object({
  results: z.array(eventSchema),
  next: z.string().nullish(),
});

const scheduledEvent = z.object({
  bots: z.array(
    z.object({
      bot_id: z.string().min(1),
      deduplication_key: z.string(),
      start_time: z.iso.datetime({ offset: true }),
    }),
  ),
});

const webhookSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("calendar.update"), data: z.object({ calendar_id: z.string() }) }),
  z.object({
    event: z.literal("calendar.sync_events"),
    data: z.object({ calendar_id: z.string(), last_updated_ts: z.iso.datetime({ offset: true }) }),
  }),
]);

function toEvent(row: z.output<typeof eventSchema>): MeetingCalendarEvent {
  return {
    id: row.id,
    calendarId: row.calendar_id,
    seriesId: row.raw?.recurringEventId ?? null,
    title: row.raw?.summary?.trim().slice(0, 300) ?? "",
    startsAt: row.start_time,
    endsAt: row.end_time,
    meetingUrl: row.meeting_url ?? null,
    cancelled: row.is_deleted || row.raw?.status === "cancelled",
    declined:
      row.raw?.attendees?.some((person) => person.self && person.responseStatus === "declined") ??
      false,
  };
}

export interface RecallCalendarOptions {
  baseUrl: string;
  apiKey: string;
  oauthClientId: string;
  oauthClientSecret: string;
  verify: (body: string, headers: Headers) => boolean;
  fetch?: typeof globalThis.fetch;
}

export class RecallCalendarProvider implements MeetingCalendarProvider {
  readonly id: string = "recall";
  readonly calendarLabel = "Google Calendar";

  constructor(private readonly options: RecallCalendarOptions) {}

  authorizationUrl({
    state,
    challenge,
    redirectUri,
  }: {
    state: string;
    challenge: string;
    redirectUri: string;
  }): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.options.oauthClientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope:
        "https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/userinfo.email",
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }

  async connect(
    {
      connectionId,
      code,
      verifier,
      redirectUri,
    }: { connectionId: string; code: string; verifier: string; redirectUri: string },
    signal: AbortSignal,
  ): Promise<{ calendarId: string }> {
    const response = await (this.options.fetch ?? fetch)("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        code_verifier: verifier,
        client_id: this.options.oauthClientId,
        client_secret: this.options.oauthClientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error("Could not redeem the calendar authorization.");
    const { refresh_token } = z
      .object({ refresh_token: z.string().min(1) })
      .parse(await readBoundedJsonResponse<unknown>(response, 2 * 1024 * 1024, signal));
    const calendar = await this.request("/api/v2/calendars/", signal, {
      method: "POST",
      body: {
        metadata: { connectionId },
        platform: "google_calendar",
        oauth_client_id: this.options.oauthClientId,
        oauth_client_secret: this.options.oauthClientSecret,
        oauth_refresh_token: refresh_token,
      },
    });
    return {
      calendarId: calendarSchema.parse(
        await readBoundedJsonResponse<unknown>(calendar, 2 * 1024 * 1024, signal),
      ).id,
    };
  }

  async status(calendarId: string, signal: AbortSignal) {
    const response = await this.request(this.calendarPath(calendarId), signal, {
      allowMissing: true,
    });
    if (response.status === 404) {
      cancelResponseBody(response);
      return "disconnected" as const;
    }
    const calendar = calendarSchema.parse(
      await readBoundedJsonResponse<unknown>(response, 2 * 1024 * 1024, signal),
    );
    return (
      calendar.status_changes.sort(
        (first, second) => Date.parse(second.created_at) - Date.parse(first.created_at),
      )[0]?.status ?? "connecting"
    );
  }

  async disconnect(calendarId: string, signal: AbortSignal): Promise<void> {
    cancelResponseBody(
      await this.request(this.calendarPath(calendarId), signal, {
        method: "DELETE",
        allowMissing: true,
      }),
    );
  }

  async *listEvents(
    calendarId: string,
    filter: { since?: Date; upcoming?: Date },
    signal: AbortSignal,
  ) {
    const url = new URL("/api/v2/calendar-events/", this.options.baseUrl);
    url.searchParams.set("calendar_id", calendarId);
    if (filter.since) url.searchParams.set("updated_at__gte", filter.since.toISOString());
    if (filter.upcoming) {
      url.searchParams.set("start_time__gte", filter.upcoming.toISOString());
      url.searchParams.set("is_deleted", "false");
    }
    let next: URL | null = url;
    const seen = new Set<string>();
    while (next) {
      if (
        next.origin !== url.origin ||
        next.pathname !== url.pathname ||
        next.searchParams.get("calendar_id") !== calendarId ||
        seen.has(next.href)
      ) {
        throw new Error("Invalid calendar event pagination.");
      }
      seen.add(next.href);
      const response = await this.request(next, signal);
      const page = eventPage.parse(
        await readBoundedJsonResponse<unknown>(response, 2 * 1024 * 1024, signal),
      );
      for (const event of page.results) {
        if (event.calendar_id !== calendarId)
          throw new Error("Calendar event belongs to another calendar.");
        yield toEvent(event);
      }
      next = page.next ? new URL(page.next, url) : null;
    }
  }

  async getEvent(eventId: string, signal: AbortSignal): Promise<MeetingCalendarEvent | null> {
    const response = await this.request(this.eventPath(eventId), signal, { allowMissing: true });
    return response.status === 404
      ? null
      : toEvent(
          eventSchema.parse(
            await readBoundedJsonResponse<unknown>(response, 2 * 1024 * 1024, signal),
          ),
        );
  }

  async schedule(
    eventId: string,
    scheduleKey: string,
    startsAt: Date,
    request: MeetingJoinRequest,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await this.request(this.eventPath(eventId, "bot/"), signal, {
      method: "POST",
      body: {
        deduplication_key: scheduleKey,
        bot_config: { ...buildRecallBotConfig(request), join_at: startsAt.toISOString() },
      },
    });
    const event = scheduledEvent.parse(
      await readBoundedJsonResponse<unknown>(response, 2 * 1024 * 1024, signal),
    );
    const current = event.bots.find(
      (bot) =>
        bot.deduplication_key === scheduleKey && Date.parse(bot.start_time) === startsAt.getTime(),
    );
    if (!current) throw new Error("The calendar provider did not return a scheduled bot.");
    return current.bot_id;
  }

  async unschedule(eventId: string, signal: AbortSignal): Promise<void> {
    cancelResponseBody(
      await this.request(this.eventPath(eventId, "bot/"), signal, {
        method: "DELETE",
        allowMissing: true,
      }),
    );
  }

  verifyChange(body: string, headers: Headers) {
    if (!this.options.verify(body, headers)) return null;
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
    const parsed = webhookSchema.safeParse(json);
    if (!parsed.success) return "ignored" as const;
    const { event, data } = parsed.data;
    return event === "calendar.update"
      ? { kind: "connection" as const, calendarId: data.calendar_id }
      : {
          kind: "events" as const,
          calendarId: data.calendar_id,
          since: new Date(data.last_updated_ts),
        };
  }

  private calendarPath(calendarId: string) {
    return `/api/v2/calendars/${encodeURIComponent(calendarId)}/`;
  }

  private eventPath(eventId: string, suffix = "") {
    return `/api/v2/calendar-events/${encodeURIComponent(eventId)}/${suffix}`;
  }

  private async request(
    path: string | URL,
    signal: AbortSignal,
    options: { method?: string; body?: unknown; allowMissing?: boolean } = {},
  ) {
    const response = await (this.options.fetch ?? fetch)(new URL(path, this.options.baseUrl), {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Token ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "error",
      signal,
    });
    if (!response.ok && !(options.allowMissing && response.status === 404)) {
      cancelResponseBody(response);
      if (response.status === 409 || response.status === 429 || response.status === 507) {
        throw new RetryJobLaterError(
          parseRetryAfter(response.headers.get("retry-after")) ?? 30_000,
        );
      }
      throw new Error(`Calendar provider returned HTTP ${response.status}.`);
    }
    return response;
  }
}
