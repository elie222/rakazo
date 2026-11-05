import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemmySearchInput, MemmySourceTurnBody } from "./memmy-memory-client.js";
import { MemmyMemoryClient, resetMemmyCircuitBreakers } from "./memmy-memory-client.js";

afterEach(resetMemmyCircuitBreakers);
const query: MemmySearchInput = {
  query: "fixture query",
  layers: ["episode"],
  limit: 1,
  contextBudget: 100,
  namespaces: [{ source: "rakazo", userId: "owner", profileId: "bot:fixture" }],
};
const capture: MemmySourceTurnBody = {
  requestId: "fixture",
  channel: "hook",
  source: "rakazo",
  namespace: { userId: "owner" },
  sourceTurn: {
    source: "rakazo",
    profileId: "bot:fixture",
    conversationId: "thread",
    turnId: "run",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:01Z",
    completionEvidence: "fixture",
  },
  query: "fixture question",
  answer: "fixture answer",
  status: "succeeded",
  toolCalls: [],
  toolResults: [],
  sourceMemoryIds: [],
};
function make(token: string, transport: typeof fetch) {
  return new MemmyMemoryClient({
    baseUrl: "http://127.0.0.1:8080",
    token,
    endpointTrust: "private",
    fetch: transport,
  });
}

describe("PR client configuration regressions", () => {
  it("does not let one invalid token open another connection's recall circuit", async () => {
    const bad = make(
      "invalid-fixture-token",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    const transport = vi.fn(
      async () => new Response(JSON.stringify({ debug: { sections: [], sourceMemoryIds: [] } })),
    );
    const good = make("valid-fixture-token", transport);
    for (let i = 0; i < 3; i += 1) await bad.search(query);
    expect((await good.search(query)).ok).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 404])(
    "keeps pending evidence recoverable after a connection-level HTTP %i",
    async (status) => {
      const client = make(
        "fixture-token",
        vi.fn(async () => new Response("{}", { status })),
      );
      expect(await client.complete(capture)).toEqual({
        status: "retryable",
        reason: status === 404 ? "connection_not_found" : "unauthorized",
      });
    },
  );
});
