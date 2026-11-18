import type { MeetingCalendarService } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  CALENDAR_OAUTH_UNAVAILABLE_ERRORS,
  DESKTOP_MEETING_CALENDAR_DENIED,
  DESKTOP_MEETING_CALENDAR_FAILED,
  DESKTOP_MEETING_CALENDAR_LAUNCH_PATH,
  MEETING_CALENDAR_CALLBACK_PATH,
  MOBILE_MEETING_CALENDAR_CALLBACK_URL,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Hono } from "hono";
import { clientErrorStatus } from "../../client-error-status.js";
import { readBoundedBody } from "../../http/http-body.js";
import type { RouterContext } from "../../routes/context.js";

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
        await repos.getBot(actor, input.botId);
        return { available: deps.meetingCalendar?.available(actor.spaceId) ?? false };
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
              : undefined,
          );
        },
      ),
      complete: authed.meetingCalendar.complete.handler(
        ({ context: { actor, sessionId }, input }) =>
          configured().authorization.complete(actor, input.state, input.code, sessionId),
      ),
      select: authed.meetingCalendar.select.handler(async ({ context: { actor }, input }) => {
        await repos.getBot(actor, input.botId);
        await configured().updateSelection(actor, input.botId, input.eventId, input.scope);
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
    if (state.startsWith("mobile-")) {
      const params = new URLSearchParams({
        state,
        ...(code ? { code } : { error: error ?? "access_denied" }),
      });
      return c.redirect(`${MOBILE_MEETING_CALENDAR_CALLBACK_URL}?${params}`, 303);
    }
    if (state.startsWith("desktop-")) {
      const target = await service.authorization.desktopHandoff(state);
      if (!target || (!code && !error)) return c.text("Invalid calendar authorization.", 400);
      // The browser cannot redeem the code. Only the initiating desktop session
      // can finish it over authenticated RPC after native loopback capture.
      target.searchParams.set("state", state);
      const result =
        error === "access_denied"
          ? DESKTOP_MEETING_CALENDAR_DENIED
          : error
            ? DESKTOP_MEETING_CALENDAR_FAILED
            : code!;
      target.searchParams.set("code", result);
      return c.redirect(target.href, 303);
    }
    if (!state.startsWith("web-")) return c.text("Invalid calendar authorization.", 400);
    if (error === "access_denied") return c.redirect("/app", 303);
    if (error && CALENDAR_OAUTH_UNAVAILABLE_ERRORS.includes(error)) {
      return c.text("Calendar sign-in is temporarily unavailable.", 503);
    }
    if (!code || error) return c.text("Calendar authorization did not complete.", 400);
    const actor = await sessionActor(c.req.raw);
    if (!actor)
      return c.text("Open Rakazo in this browser and sign in, then connect your calendar.", 401);
    try {
      await service.authorization.completeFromBrowser(actor.userId, state, code);
    } catch (cause) {
      if (cause instanceof ClientError) return c.text(cause.message, clientErrorStatus(cause.kind));
      throw cause;
    }
    return c.redirect("/app", 303);
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
