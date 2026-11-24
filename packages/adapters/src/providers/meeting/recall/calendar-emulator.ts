import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { RecallCalendarProvider } from "./calendar-provider.js";
import { verifyRecallSignature } from "./recall-meeting.js";

const origin = "https://meeting-provider.example.test";
const dayMs = 24 * 60 * 60_000;
const secret = `whsec_${Buffer.from("calendar-emulator-secret").toString("base64")}`;
const signatureConfig = { prefix: "webhook", secret } as const;
const oauthCode = "offline-calendar-code";

type CalendarState = "connecting" | "connected" | "disconnected";
type CalendarFixture = {
  id: string;
  metadata: { rakazoConnectionRef: string };
  created_at: string;
  status_changes: [{ status: CalendarState; created_at: string }];
};

interface FakeEvent {
  id: string;
  calendar_id: string;
  is_deleted: boolean;
  start_time: string;
  end_time: string;
  meeting_url: string;
  raw: {
    summary: string;
    recurringEventId?: string;
    status?: string;
    attendees?: Array<{ self: boolean; responseStatus: string }>;
  };
}

export class RecallCalendarEmulator {
  readonly provider: RecallCalendarProvider;
  private readonly calendars = new Map<string, FakeEvent[]>();
  private readonly connections = new Map<string, CalendarFixture>();
  private nextConnectionReply?: Promise<void>;
  private nextScheduleReply?: Promise<void>;
  private breakNextConnection = false;
  private nextExchangeStatus?: number;
  private readonly schedules = new Map<
    string,
    { botId: string; meetingUrl: string; key: string }
  >();
  private failNextStatus: number | undefined;
  private nextDisconnectStatus?: number;

  constructor(now = new Date(), providerId = "emulator") {
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin === "https://oauth2.googleapis.com") {
        const code = new URLSearchParams(await request.text()).get("code");
        const status = this.nextExchangeStatus;
        this.nextExchangeStatus = undefined;
        if (status) return new Response(null, { status });
        return code === oauthCode
          ? Response.json({ refresh_token: "offline-refresh" })
          : Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return this.respond(request, now);
    };

    this.provider = new (class extends RecallCalendarProvider {
      override readonly id = providerId;
      override authorizationUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
        const url = new URL(redirectUri);
        url.searchParams.set("state", state);
        url.searchParams.set("code", oauthCode);
        return url.href;
      }
    })({
      baseUrl: origin,
      apiKey: "offline-calendar-api-key",
      oauthClientId: "offline-calendar-client",
      oauthClientSecret: "offline-calendar-secret",
      fetch,
      verify: (body, headers) => verifyRecallSignature(signatureConfig, body, headers),
    });
  }

  connectedCalendars() {
    return [...this.connections.keys()];
  }

  holdNextConnectionReply(until: Promise<void>) {
    this.nextConnectionReply = until;
  }

  failNextOAuthExchange(status: number) {
    this.nextExchangeStatus = status;
  }

  loseNextConnectionReply() {
    this.breakNextConnection = true;
  }

  failNextDisconnect(status: number) {
    this.nextDisconnectStatus = status;
  }

  setCalendarStatus(calendarId: string, status: CalendarState) {
    const connection = this.connections.get(calendarId);
    if (!connection) throw new Error("No such emulator calendar connection");
    connection.status_changes[0].status = status;
  }

  revision(
    eventId: string,
    patch: Partial<
      Pick<FakeEvent, "start_time" | "end_time" | "is_deleted" | "meeting_url" | "raw">
    >,
  ) {
    for (const events of this.calendars.values()) {
      const event = events.find(({ id }) => id === eventId);
      if (event) {
        Object.assign(event, patch);
        return;
      }
    }
    throw new Error("No such emulator calendar event");
  }

  scheduled(eventId: string) {
    return this.schedules.get(eventId)?.botId;
  }

  scheduledLink(eventId: string) {
    return this.schedules.get(eventId)?.meetingUrl;
  }

  holdNextScheduleReply(until: Promise<void>) {
    this.nextScheduleReply = until;
  }

  denyNextSchedule(status: number) {
    this.failNextStatus = status;
  }

  change(calendarId: string) {
    const now = new Date();
    const body = JSON.stringify({
      event: "calendar.sync_events",
      data: { calendar_id: calendarId, last_updated_ts: now.toISOString() },
    });
    const id = randomUUID();
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const digest = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");
    return {
      body,
      headers: new Headers({
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${digest}`,
      }),
    };
  }

  private async respond(request: Request, now: Date) {
    const url = new URL(request.url);
    if (
      url.origin !== origin ||
      request.headers.get("Authorization") !== "Token offline-calendar-api-key"
    ) {
      return new Response(null, { status: 403 });
    }
    const [, api, version, resource, id, child] = url.pathname.split("/");
    if (api !== "api" || version !== "v2") return new Response(null, { status: 404 });
    if (resource === "calendars") {
      if (!id && request.method === "POST") {
        const body = z
          .object({
            platform: z.literal("google_calendar"),
            oauth_client_id: z.literal("offline-calendar-client"),
            oauth_client_secret: z.literal("offline-calendar-secret"),
            oauth_refresh_token: z.literal("offline-refresh"),
            metadata: z.object({ rakazoConnectionRef: z.string().min(1) }),
          })
          .parse(await request.json());
        const calendarId = body.metadata.rakazoConnectionRef.split(".", 1)[0]!;
        const events = [
          this.event(
            calendarId,
            now,
            1,
            "Design review",
            "https://meet.google.com/abc-defg-hij",
            "design-review",
          ),
          this.event(calendarId, now, 2, "Launch planning", "https://zoom.us/j/12345678901"),
          this.event(
            calendarId,
            now,
            8,
            "Design review",
            "https://meet.google.com/abc-defg-hij",
            "design-review",
          ),
        ];
        this.calendars.set(calendarId, events);
        const connection: CalendarFixture = {
          id: calendarId,
          metadata: body.metadata,
          created_at: now.toISOString(),
          status_changes: [{ status: "connected", created_at: now.toISOString() }],
        };
        this.connections.set(calendarId, connection);
        const until = this.nextConnectionReply;
        this.nextConnectionReply = undefined;
        if (until) await until;
        request.signal.throwIfAborted();
        if (this.breakNextConnection) {
          this.breakNextConnection = false;
          return new Response(null, { status: 503 });
        }
        return Response.json(connection, { status: 201 });
      }
      if (!id && request.method === "GET") {
        const since = url.searchParams.get("created_at__gte");
        const results = [...this.connections.values()].filter(
          (connection) => !since || connection.created_at >= since,
        );
        return Response.json({ results, next: null });
      }
      const connection = this.connections.get(id ?? "");
      const events = this.calendars.get(id ?? "");
      if (id && connection && events) {
        if (request.method === "DELETE") {
          const status = this.nextDisconnectStatus;
          this.nextDisconnectStatus = undefined;
          if (status) return new Response(null, { status });
          this.calendars.delete(id);
          this.connections.delete(id);
          for (const event of events) this.schedules.delete(event.id);
          return new Response(null, { status: 204 });
        }
        return Response.json(connection);
      }
    }
    if (resource === "calendar-events") {
      if (!id && request.method === "GET") {
        const events = this.calendars.get(url.searchParams.get("calendar_id") ?? "");
        if (!events) return new Response(null, { status: 404 });
        const start = url.searchParams.get("start_time__gte");
        const end = url.searchParams.get("start_time__lte");
        const live = events.filter(
          (event) =>
            (!start || event.start_time >= start) &&
            (!end || event.start_time <= end) &&
            (url.searchParams.get("is_deleted") !== "false" || !event.is_deleted),
        );
        const pageSize = 2;
        const cursor = Number(url.searchParams.get("cursor") ?? "0");
        const results = live.slice(cursor, cursor + pageSize).map((event) => ({
          ...event,
          raw: JSON.stringify(event.raw),
        }));
        const next = new URL(url);
        next.searchParams.set("cursor", String(cursor + pageSize));
        return Response.json({ results, next: cursor + pageSize < live.length ? next.href : null });
      }
      const event = [...this.calendars.values()].flat().find((candidate) => candidate.id === id);
      if (event) {
        if (child === "bot" && request.method === "POST") {
          const fail = this.failNextStatus;
          this.failNextStatus = undefined;
          if (fail) return new Response(null, { status: fail });
          if (event.is_deleted) return new Response(null, { status: 400 });
          const body = z
            .object({
              deduplication_key: z.string().min(1),
              bot_config: z.object({
                bot_name: z.string().min(1),
                meeting_url: z.url(),
                join_at: z.iso.datetime({ offset: true }),
                recording_config: z.object({ retention: z.object({ hours: z.number() }) }),
                metadata: z.object({ meetingSessionId: z.string().min(1) }),
              }),
            })
            .parse(await request.json());
          const key = body.deduplication_key;
          const existing = [...this.schedules.values()].find((schedule) => schedule.key === key);
          const botId = existing?.botId ?? randomUUID();
          this.schedules.set(event.id, { botId, meetingUrl: body.bot_config.meeting_url, key });
          const until = this.nextScheduleReply;
          this.nextScheduleReply = undefined;
          if (until) await until;
          request.signal.throwIfAborted();
          return Response.json({
            bots: [{ bot_id: botId, start_time: body.bot_config.join_at, deduplication_key: key }],
          });
        }
        if (child === "bot" && request.method === "DELETE") {
          this.schedules.delete(event.id);
          return Response.json({ bots: [] });
        }
        return Response.json(event);
      }
    }
    return new Response(null, { status: 404 });
  }

  private event(
    calendarId: string,
    now: Date,
    daysAhead: number,
    title: string,
    link: string,
    series?: string,
  ): FakeEvent {
    const starts = new Date(now.getTime() + daysAhead * dayMs);
    starts.setUTCHours(16, 0, 0, 0);
    return {
      id: randomUUID(),
      calendar_id: calendarId,
      is_deleted: false,
      start_time: starts.toISOString(),
      end_time: new Date(starts.getTime() + 30 * 60_000).toISOString(),
      meeting_url: link,
      raw: { summary: title, recurringEventId: series, status: "confirmed" },
    };
  }
}
