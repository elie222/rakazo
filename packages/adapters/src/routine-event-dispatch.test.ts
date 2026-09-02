import { describe, expect, it, vi } from "vitest";
import {
  dispatchRoutineEvents,
  eventsFromWebhookPayload,
  pickPromptEvent,
  webhookDeliveryIdempotency,
  webhookDeliveryIdempotencyKey,
  webhookDeliveryIdempotencyKeys,
} from "./routine-event-dispatch.js";

describe("routine event dispatch", () => {
  it("normalizes webhook payloads into webhook and repo events when possible", () => {
    const events = eventsFromWebhookPayload(
      {
        action: "opened",
        pull_request: { merged: false },
        repository: { full_name: "acme/app" },
      },
      { eventName: "pull_request" },
    );
    expect(events.map((event) => event.source)).toEqual(["webhook", "repo"]);
    expect(events[1]).toMatchObject({ source: "repo", repo: "acme/app", event: "pr_opened" });
  });

  it("prefers a matching repo event over the generic webhook event for the prompt", () => {
    const triggers = [
      { id: "w1", kind: "webhook" as const },
      {
        id: "r1",
        kind: "repo" as const,
        repo: "acme/app",
        events: ["pr_opened" as const],
      },
    ];
    const events = eventsFromWebhookPayload(
      {
        action: "opened",
        pull_request: { merged: false },
        repository: { full_name: "acme/app" },
      },
      { eventName: "pull_request" },
    );
    expect(pickPromptEvent(triggers, events).source).toBe("repo");
  });

  it("wakes matching routines once per event batch with idempotency keys", async () => {
    const wakeRoutineFromEvent = vi.fn(async (routineId: string) => ({
      runId: `run-${routineId}`,
      threadId: "thread-1",
    }));
    const deps = {
      prisma: {
        routine: {
          findMany: vi.fn(async () => [
            {
              id: "routine-webhook",
              webhookEnabled: true,
              eventTriggers: [{ id: "w1", kind: "webhook" }],
            },
            {
              id: "routine-repo",
              webhookEnabled: false,
              eventTriggers: [
                {
                  id: "r1",
                  kind: "repo",
                  repo: "acme/app",
                  events: ["pr_opened"],
                },
              ],
            },
            {
              id: "routine-other",
              webhookEnabled: false,
              eventTriggers: [
                {
                  id: "r2",
                  kind: "repo",
                  repo: "acme/other",
                  events: ["push"],
                },
              ],
            },
          ]),
        },
      },
      wakeRoutineFromEvent,
    };

    const results = await dispatchRoutineEvents({
      deps,
      botId: "bot-1",
      spaceId: "space-1",
      events: eventsFromWebhookPayload(
        {
          action: "opened",
          pull_request: { merged: false },
          repository: { full_name: "acme/app" },
        },
        { eventName: "pull_request" },
      ),
      idempotencyKey: "webhook:bot-1:abc",
    });

    expect(results.map((row) => row.routineId).sort()).toEqual(["routine-repo", "routine-webhook"]);
    expect(wakeRoutineFromEvent).toHaveBeenCalledTimes(2);
    const calls = wakeRoutineFromEvent.mock.calls as unknown as Array<
      [string, { source: string; event?: string }, { idempotencyKey?: string }?]
    >;
    expect(calls[0]?.[2]?.idempotencyKey).toMatch(/^routine-event:/);
    const repoCall = calls.find((call) => call[0] === "routine-repo");
    expect(repoCall?.[1]).toMatchObject({ source: "repo", event: "pr_opened" });
  });

  it("skips inactive routines via the active filter", async () => {
    const wakeRoutineFromEvent = vi.fn(async () => ({ runId: "run-1", threadId: "thread-1" }));
    const findMany = vi.fn(async () => []);
    await dispatchRoutineEvents({
      deps: {
        prisma: { routine: { findMany } },
        wakeRoutineFromEvent,
      },
      botId: "bot-1",
      spaceId: "space-1",
      events: [{ source: "webhook", payload: {} }],
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ active: true }),
      }),
    );
    expect(wakeRoutineFromEvent).not.toHaveBeenCalled();
  });

  it("body-hashes the raw body when no delivery id is present", () => {
    const headers = { get: () => null };
    const key = webhookDeliveryIdempotencyKey({
      botId: "bot-1",
      headers,
      payload: { text: "hello" },
      rawBody: '{"text":"hello"}',
    });
    expect(key).toMatch(/^webhook:bot-1:/);
    expect(
      webhookDeliveryIdempotencyKey({
        botId: "bot-1",
        headers,
        payload: { text: "hello" },
        rawBody: '{"text":"hello"}',
      }),
    ).toBe(key);
  });

  it("uses one stable body-hash key across time so boundary retries cannot double-claim", () => {
    const headers = { get: () => null };
    const first = webhookDeliveryIdempotencyKeys({
      botId: "bot-1",
      headers,
      payload: { text: "hello" },
      rawBody: '{"text":"hello"}',
    });
    const second = webhookDeliveryIdempotencyKeys({
      botId: "bot-1",
      headers,
      payload: { text: "hello" },
      rawBody: '{"text":"hello"}',
    });
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("marks body-hash and explicit deliveries as strict durable claims", () => {
    const headers = { get: () => null };
    const bodyHash = webhookDeliveryIdempotency({
      botId: "bot-1",
      headers,
      payload: { text: "hello" },
      rawBody: '{"text":"hello"}',
    });
    expect(bodyHash.scope).toBe("strict");
    expect(bodyHash.keys).toHaveLength(1);

    const explicit = webhookDeliveryIdempotency({
      botId: "bot-1",
      headers: { get: (name: string) => (name === "x-github-delivery" ? "deliv-1" : null) },
      payload: { text: "hello" },
    });
    expect(explicit.scope).toBe("strict");
    expect(explicit.keys).toHaveLength(1);
  });

  it("does not treat payload id as a strict delivery key", () => {
    const headers = { get: () => null };
    const withId = webhookDeliveryIdempotency({
      botId: "bot-1",
      headers,
      payload: { id: "resource-1", text: "a" },
      rawBody: '{"id":"resource-1","text":"a"}',
    });
    const other = webhookDeliveryIdempotency({
      botId: "bot-1",
      headers,
      payload: { id: "resource-1", text: "b" },
      rawBody: '{"id":"resource-1","text":"b"}',
    });
    // Same resource id, different bodies => different body-hash keys.
    expect(withId.keys[0]).not.toBe(other.keys[0]);
    expect(withId.scope).toBe("strict");
  });
});
