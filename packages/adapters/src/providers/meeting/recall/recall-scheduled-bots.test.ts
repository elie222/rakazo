import type { MeetingJoinRequest } from "@rakazo/adapter-kit";
import { MeetingCalendarScheduleRejected } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { RecallScheduledBots } from "./recall-scheduled-bots.js";

const signal = new AbortController().signal;
const botId = "7f2d1c4e-0a5b-4c6d-8e9f-0123456789ab";
const request: MeetingJoinRequest = {
  sessionId: "session-1",
  meetingUrl: "https://meet.google.com/abc-defg-hij",
  platform: "google_meet",
  botName: "Atlas · Rakazo",
  expiresAt: new Date("2026-11-23T11:00:00Z"),
};
const joinAt = new Date("2026-11-23T09:00:00Z");

function provider(routes: Record<string, () => Response>) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = `${url.pathname}${url.search}`;
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${path}`];
    return route ? route() : new Response("", { status: 500 });
  }) as typeof globalThis.fetch;
  const bots = new RecallScheduledBots({
    origin: "https://eu-central-1.recall.ai",
    apiKey: "key",
    fetch,
  });
  return { bots, calls };
}

const listPath = "/api/v1/bot/?metadata__meetingSessionId=session-1";
const json =
  (value: unknown, status = 200) =>
  () =>
    Response.json(value, { status });

describe("RecallScheduledBots", () => {
  it("creates a bot that joins at the meeting start, tagged with its session", async () => {
    const { bots, calls } = provider({
      [`GET ${listPath}`]: json({ results: [] }),
      "POST /api/v1/bot/": json({ id: botId }, 201),
    });
    expect(await bots.schedule(request, joinAt, signal)).toBe(botId);
    expect(calls[1]?.body).toMatchObject({
      meeting_url: request.meetingUrl,
      bot_name: request.botName,
      join_at: "2026-11-23T09:00:00.000Z",
      metadata: { meetingSessionId: "session-1" },
    });
  });

  it("updates the session's existing bot instead of creating a second one", async () => {
    const { bots, calls } = provider({
      [`GET ${listPath}`]: json({ results: [{ id: botId }] }),
      [`PATCH /api/v1/bot/${botId}/`]: json({ id: botId }),
    });
    expect(await bots.schedule(request, joinAt, signal)).toBe(botId);
    expect(calls.map(({ method }) => method)).toEqual(["GET", "PATCH"]);

    const late = provider({
      [`GET ${listPath}`]: json({ results: [{ id: botId }] }),
      [`PATCH /api/v1/bot/${botId}/`]: json({ code: "update_bot_failed" }, 400),
    });
    expect(await late.bots.schedule(request, joinAt, signal)).toBe(botId);
  });

  it("reports a refused meeting as a definite rejection", async () => {
    const { bots } = provider({
      [`GET ${listPath}`]: json({ results: [] }),
      "POST /api/v1/bot/": json({ meeting_url: ["invalid"] }, 400),
    });
    await expect(bots.schedule(request, joinAt, signal)).rejects.toThrow(
      MeetingCalendarScheduleRejected,
    );
  });

  it("deletes a scheduled bot, and asks a launched one to leave", async () => {
    const deleted = provider({
      [`DELETE /api/v1/bot/${botId}/`]: () => new Response(null, { status: 204 }),
    });
    await deleted.bots.cancel("session-1", botId, signal);
    expect(deleted.calls.map(({ method }) => method)).toEqual(["DELETE"]);

    const launched = provider({
      [`GET ${listPath}`]: json({ results: [{ id: botId }] }),
      [`DELETE /api/v1/bot/${botId}/`]: json({ detail: "already dispatched" }, 400),
      [`POST /api/v1/bot/${botId}/leave_call/`]: json({}),
    });
    await launched.bots.cancel("session-1", null, signal);
    expect(launched.calls.map(({ method }) => method)).toEqual(["GET", "DELETE", "POST"]);

    const none = provider({ [`GET ${listPath}`]: json({ results: [] }) });
    await none.bots.cancel("session-1", null, signal);
    expect(none.calls).toHaveLength(1);
  });
});
