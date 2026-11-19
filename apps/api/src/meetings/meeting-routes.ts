import type { MeetingService } from "@rakazo/adapters";
import { ClientError } from "@rakazo/core";
import type { Hono } from "hono";
import { readBoundedBody } from "../http/http-body.js";
import type { RouterContext } from "../routes/context.js";

export function meetingRoutes({ authed, deps }: RouterContext) {
  const service = deps.meetings;
  function requireMeetings() {
    if (!service) throw new ClientError("NOT_FOUND", "Meetings are unavailable.");
    return service;
  }
  return {
    meetings: {
      list: authed.meetings.list.handler(
        ({ input, context }) =>
          service?.list(context.actor, input.botId) ?? { enabled: false, meetings: [] },
      ),
      join: authed.meetings.join.handler(({ input, context }) =>
        requireMeetings().join(context.actor, input.botId, input.url, input.shareTranscript),
      ),
      leave: authed.meetings.leave.handler(({ input, context }) =>
        requireMeetings().leave(context.actor, input.id),
      ),
      transcript: authed.meetings.transcript.handler(async ({ input, context }) => {
        const { turns, artifactAvailable } = await requireMeetings().transcript(
          context.actor,
          input.id,
        );
        return { turns, artifactAvailable };
      }),
      shareTranscript: authed.meetings.shareTranscript.handler(({ input, context }) =>
        requireMeetings().shareTranscript(context.actor, input.id),
      ),
      deleteTranscript: authed.meetings.deleteTranscript.handler(({ input, context }) =>
        requireMeetings().deleteTranscript(context.actor, input.id),
      ),
      ask: authed.meetings.ask.handler(async ({ input, context }) => {
        const { turns, botId } = await requireMeetings().transcript(context.actor, input.id);
        if (!deps.meetingAnswers)
          throw new ClientError("SERVICE_UNAVAILABLE", "Meeting answers are unavailable.");
        return {
          answer: await deps.meetingAnswers(
            context.actor,
            botId,
            turns,
            input.question,
            context.signal,
          ),
        };
      }),
    },
  };
}

export function mountMeetingWebhook(app: Hono, service: MeetingService) {
  app.post("/api/meetings/events", async (c) => {
    const raw = await readBoundedBody(c.req.raw, 128 * 1024);
    if (raw === null) return c.body(null, 413);
    const event = service.parseWebhook(raw, c.req.raw.headers);
    if (event === "invalid") return c.body(null, 401);
    if (event !== "ignored") await service.accept(event);
    return c.body(null, 204);
  });
}
