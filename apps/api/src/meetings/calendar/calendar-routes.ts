import type { MeetingCalendarService } from "@rakazo/adapters";
import type { Actor, MeetingCalendarOAuthError } from "@rakazo/contracts";
import {
  DESKTOP_MEETING_CALENDAR_DENIED,
  DESKTOP_MEETING_CALENDAR_FAILED,
  DESKTOP_MEETING_CALENDAR_LAUNCH_PATH,
  DESKTOP_MEETING_CALENDAR_UNAVAILABLE,
  MEETING_CALENDAR_CALLBACK_PATH,
  MEETING_CALENDAR_RETURN_PARAM,
  MOBILE_MEETING_CALENDAR_CALLBACK_URL,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Hono } from "hono";
import { clientErrorStatus } from "../../client-error-status.js";
import { readBoundedBody } from "../../http/http-body.js";
import type { RouterContext } from "../../routes/context.js";

function calendarOAuthError(error: string | undefined): MeetingCalendarOAuthError {
  switch (error) {
    case "access_denied":
      return "denied";
    case "temporarily_unavailable":
    case "server_error":
      return "unavailable";
    default:
      return "failed";
  }
}

const desktopOAuthErrors = {
  denied: DESKTOP_MEETING_CALENDAR_DENIED,
  unavailable: DESKTOP_MEETING_CALENDAR_UNAVAILABLE,
  failed: DESKTOP_MEETING_CALENDAR_FAILED,
} satisfies Record<MeetingCalendarOAuthError, string>;

export function meetingCalendarRoutes(ctx: RouterContext) {
  const { authed, deps, repos } = ctx;
  const configured = () => {
    if (!deps.meetingCalendar)
      throw new ClientError("NOT_FOUND", "Calendar scheduling is unavailable.");
    return deps.meetingCalendar;
  };
  return {
    meetingCalendar: {
      status: authed.meetingCalendar.status.handler(async ({ context: { actor }, input }) => {
        const available = deps.meetingCalendar?.available(actor.spaceId) ?? false;
        if (available) await repos.getBot(actor, input.botId);
        return { available };
      }),
      upcoming: authed.meetingCalendar.upcoming.handler(async ({ context: { actor }, input }) => {
        if (!deps.meetingCalendar)
          return { available: false, connected: false, calendarLabel: "", events: [] };
        await repos.getBot(actor, input.botId);
        return deps.meetingCalendar.upcoming(actor, input.botId);
      }),
      begin: authed.meetingCalendar.begin.handler(
        async ({ context: { actor, sessionId }, input }) => {
          await repos.getBot(actor, input.botId);
          return configured().authorization.begin(
            actor,
            input.client,
            input.client === "desktop"
              ? { loopbackPort: input.loopbackPort, sessionId }
              : { botId: input.botId },
          );
        },
      ),
      complete: authed.meetingCalendar.complete.handler(
        ({ context: { actor, sessionId }, input }) =>
          configured().authorization.complete(actor, input.state, input.code, sessionId),
      ),
      select: authed.meetingCalendar.select.handler(async ({ context: { actor }, input }) => {
        await repos.getBot(actor, input.botId);
        await configured().updateSelection(
          actor,
          input.botId,
          input.eventId,
          input.scope,
          input.shareTranscript,
        );
      }),
      skip: authed.meetingCalendar.skip.handler(async ({ context: { actor }, input }) => {
        await repos.getBot(actor, input.botId);
        await configured().updateSelection(actor, input.botId, input.eventId, "skip");
      }),
      removeSeries: authed.meetingCalendar.removeSeries.handler(
        async ({ context: { actor }, input }) => {
          await repos.getBot(actor, input.botId);
          await configured().updateSelection(actor, input.botId, input.eventId, "removeSeries");
        },
      ),
      disconnect: authed.meetingCalendar.disconnect.handler(({ context: { actor } }) =>
        configured().disconnect(actor),
      ),
    },
  };
}

export function mountMeetingCalendarHttp(
  app: Hono,
  service: MeetingCalendarService,
  sessionActor: (request: Request) => Promise<Actor | null>,
) {
  app.get(DESKTOP_MEETING_CALENDAR_LAUNCH_PATH, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const [state, ...extra] = c.req.queries("state") ?? [];
    if (!state || extra.length) return c.text("Invalid calendar authorization.", 400);
    const target = await service.authorization.launchDesktop(state);
    return target
      ? c.redirect(target, 303)
      : c.text("Return to Rakazo and start calendar sign-in again.", 400);
  });

  app.get(MEETING_CALENDAR_CALLBACK_PATH, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const { state, code, error } = c.req.query();
    if (["state", "code", "error"].some((name) => (c.req.queries(name)?.length ?? 0) > 1)) {
      return c.text("Invalid calendar authorization.", 400);
    }
    if (!state || state.length > 128 || (code && code.length > 8192))
      return c.text("Invalid calendar authorization.", 400);
    const failure = error !== undefined || !code ? calendarOAuthError(error) : undefined;
    if (state.startsWith("mobile-")) {
      const params = new URLSearchParams({
        state,
        ...(failure ? { error: failure } : { code: code! }),
      });
      return c.redirect(`${MOBILE_MEETING_CALENDAR_CALLBACK_URL}?${params}`, 303);
    }
    if (state.startsWith("desktop-")) {
      const target = await service.authorization.desktopHandoff(state);
      if (!target || (!code && !error)) return c.text("Invalid calendar authorization.", 400);
      // The browser cannot redeem the code. Only the initiating desktop session
      // can finish it over authenticated RPC after native loopback capture.
      target.searchParams.set("state", state);
      target.searchParams.set("code", failure ? desktopOAuthErrors[failure] : code!);
      return c.redirect(target.href, 303);
    }
    if (!state.startsWith("web-")) return c.text("Invalid calendar authorization.", 400);
    if (failure === "denied") return c.redirect("/app", 303);
    if (failure === "unavailable") {
      return c.text("Calendar sign-in is temporarily unavailable.", 503);
    }
    if (!code || failure) return c.text("Calendar authorization did not complete.", 400);
    const actor = await sessionActor(c.req.raw);
    if (!actor)
      return c.text("Open Rakazo in this browser and sign in, then connect your calendar.", 401);
    try {
      const botId = await service.authorization.completeFromBrowser(actor.userId, state, code);
      return c.redirect(
        botId ? `/app/${encodeURIComponent(botId)}?${MEETING_CALENDAR_RETURN_PARAM}=1` : "/app",
        303,
      );
    } catch (cause) {
      if (cause instanceof ClientError) return c.text(cause.message, clientErrorStatus(cause.kind));
      throw cause;
    }
  });

  app.post("/api/meetings/calendar/webhook", async (c) => {
    const body = await readBoundedBody(c.req.raw, 64 * 1024);
    if (body === null) return c.text("Payload too large.", 413);
    const change = service.verifyChange(body, c.req.raw.headers);
    if (!change) return c.text("Invalid signature.", 400);
    if (change !== "ignored") await service.providerChanged(change.calendarId);
    return c.body(null, 204);
  });
}
