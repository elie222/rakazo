import type { TurnMemoryCaptureResult } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { MemmySourceTurnBody } from "./memmy-memory-client.js";
import { MemmyMemoryClient } from "./memmy-memory-client.js";

// Isolate external audit persistence; the client, HTTP exchange, and classifier stay real.
vi.mock("@rakazo/db", () => ({ recordSecurityEvent: vi.fn() }));

const captureBody: MemmySourceTurnBody = {
  requestId: "r5-request",
  channel: "hook",
  source: "rakazo",
  namespace: { userId: "fixture-owner" },
  sourceTurn: {
    source: "rakazo",
    profileId: "bot:fixture-bot",
    conversationId: "fixture-thread",
    turnId: "fixture-run",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    sequence: 1,
    completionEvidence: "fixture-completed",
  },
  query: "Remember the fixture decision.",
  answer: "The fixture uses a local stub.",
  status: "succeeded",
  toolCalls: [],
  toolResults: [],
  sourceMemoryIds: [],
};

/** The injected transport never opens a socket, including for the loopback URL. */
function fixture(reply: () => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => reply());
  const client = new MemmyMemoryClient({
    baseUrl: "http://127.0.0.1:18971",
    token: "r5-offline-fixture-token",
    endpointTrust: "private",
    fetch: fetchImpl,
  });
  return { client, fetchImpl };
}

const completionReplies: Array<{
  label: string;
  body: unknown;
  expected: TurnMemoryCaptureResult;
}> = [
  { label: "stored", body: { status: "stored" }, expected: { status: "stored" } },
  { label: "existing", body: { status: "existing" }, expected: { status: "existing" } },
  {
    label: "conflict",
    body: { status: "conflict", reason: "source_turn_content_conflict" },
    expected: { status: "terminal", reason: "source_turn_content_conflict" },
  },
  {
    label: "rejected",
    body: { status: "rejected", reason: "capture_policy" },
    expected: { status: "terminal", reason: "capture_policy" },
  },
  {
    label: "terminal pending",
    body: { status: "pending", reason: "source_session_closed" },
    expected: { status: "terminal", reason: "source_session_closed" },
  },
  {
    label: "retryable pending",
    body: { status: "pending", reason: "source_turn_out_of_order" },
    expected: { status: "retryable", reason: "source_turn_out_of_order" },
  },
];

const httpFailures: Array<{ http: number; expected: TurnMemoryCaptureResult }> = [
  { http: 401, expected: { status: "terminal", reason: "unauthorized" } },
  { http: 403, expected: { status: "terminal", reason: "unauthorized" } },
  { http: 409, expected: { status: "terminal", reason: "rejected_409" } },
  { http: 422, expected: { status: "terminal", reason: "rejected_422" } },
  { http: 429, expected: { status: "retryable", reason: "http_429" } },
  { http: 500, expected: { status: "retryable", reason: "http_500" } },
];

describe("R5 complete HTTP and body contract", () => {
  // Existing tests cover ordinary 200 replies; exercise the rest of the successful class.
  it.each(
    [201, 202, 299].flatMap((http) => completionReplies.map((reply) => ({ http, ...reply }))),
  )("HTTP $http / $label returns the body contract", async ({ http, body, expected }) => {
    const { client, fetchImpl } = fixture(
      () => new Response(JSON.stringify(body), { status: http }),
    );
    expect(await client.complete(captureBody)).toEqual(expected);
    // Retry scheduling belongs to the durable job, not an implicit HTTP resend.
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(
    httpFailures.flatMap((failure) =>
      [
        { label: "misleading stored", body: '{"status":"stored"}' },
        { label: "malformed JSON", body: "<html>upstream error</html>" },
      ].map((reply) => ({ ...failure, ...reply })),
    ),
  )("HTTP $http wins over $label", async ({ http, body, expected }) => {
    const { client } = fixture(() => new Response(body, { status: http }));
    expect(await client.complete(captureBody)).toEqual(expected);
  });

  it("does not accept a stored body on a redirect response", async () => {
    const { client, fetchImpl } = fixture(
      () => new Response('{"status":"stored"}', { status: 302 }),
    );
    expect(await client.complete(captureBody)).toEqual({ status: "retryable", reason: "http_302" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it.each([204, 205])(
    "HTTP %i without a completion body is not an acknowledgement",
    async (http) => {
      const { client } = fixture(() => new Response(null, { status: http }));
      expect(await client.complete(captureBody)).toEqual({
        status: "retryable",
        reason: "invalid_json",
      });
    },
  );

  it.each([
    ["null", "null", "invalid_json"],
    ["array", '[{"status":"stored"}]', "invalid_json"],
    ["string", '"stored"', "invalid_json"],
    ["number", "42", "invalid_json"],
    ["boolean", "true", "invalid_json"],
    ["missing status", "{}", "unexpected_status:missing"],
    ["null status", '{"status":null}', "unexpected_status:missing"],
    ["numeric status", '{"status":1}', "unexpected_status:missing"],
    ["empty status", '{"status":""}', "unexpected_status:"],
    ["case mismatch", '{"status":"Stored"}', "unexpected_status:Stored"],
    ["trailing whitespace", '{"status":"stored "}', "unexpected_status:stored "],
    ["truncated JSON", '{"status":"stored"', "invalid_json"],
  ])("does not acknowledge malformed %s", async (_label, body, reason) => {
    const { client } = fixture(() => new Response(body, { status: 200 }));
    expect(await client.complete(captureBody)).toEqual({ status: "retryable", reason });
  });

  it.each(
    ["conflict", "rejected", "pending"].flatMap((status) =>
      [null, 42, ""].map((reason) => ({ status, reason })),
    ),
  )("uses the $status fallback for reason=$reason", async ({ status, reason }) => {
    const { client } = fixture(() => new Response(JSON.stringify({ status, reason })));
    expect(await client.complete(captureBody)).toEqual({
      status: status === "pending" ? "retryable" : "terminal",
      reason: status,
    });
  });

  it.each([
    { http: 401, expected: { status: "terminal", reason: "unauthorized" } },
    { http: 422, expected: { status: "terminal", reason: "rejected_422" } },
  ])(
    "keeps HTTP $http terminal when its response body stream fails",
    async ({ http, expected }) => {
      const { client } = fixture(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("fixture response stream interrupted"));
              },
            }),
            { status: http },
          ),
      );
      // The received HTTP rejection is conclusive even when its optional diagnostic body fails.
      expect(await client.complete(captureBody)).toEqual(expected);
    },
  );

  it("retries a failed successful-response body read without treating headers as stored", async () => {
    const { client } = fixture(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("fixture response stream interrupted"));
            },
          }),
          { status: 200 },
        ),
    );
    expect(await client.complete(captureBody)).toEqual({
      status: "retryable",
      reason: "network_error",
    });
  });

  it("returns retryable for a connection reset before any HTTP response", async () => {
    const { client, fetchImpl } = fixture(() => {
      throw Object.assign(new Error("fixture socket reset"), { code: "ECONNRESET" });
    });
    expect(await client.complete(captureBody)).toEqual({
      status: "retryable",
      reason: "network_error",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
