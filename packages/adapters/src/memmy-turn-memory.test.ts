import type { AdapterContext, TurnMemoryCapture } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMMY_SEARCH_TIMEOUT_MS, resetMemmyCircuitBreakers } from "./memmy-memory-client.js";
import {
  createMemmyProvider,
  createMemmyTurnMemory,
  MEMMY_PROVIDER_ID,
  memmyCaptureBody,
  prepareMemmyConnection,
} from "./memmy-turn-memory.js";
import { MemoryProviderPrivateEndpointRequiredError } from "./serenity-memory-provider.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

const settings = { baseUrl: "http://127.0.0.1:8080", ownerId: "owner-1" };
const credentials = { token: "test-token-not-real" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(fetchImpl: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = fetchImpl.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(String(init.body));
}

function urlOf(fetchImpl: ReturnType<typeof vi.fn>, call = 0): unknown {
  return (fetchImpl.mock.calls[call] as unknown[] | undefined)?.[0];
}

const searchReply = {
  injectedContext: "",
  debug: {
    sections: [
      { id: "s-1", memoryLayer: "Skill", memoryIds: ["skill-1"], content: "Do X then Y." },
      { id: "s-2", memoryLayer: "L3", memoryIds: ["wm-1"], content: "Prod is read-only." },
    ],
    sourceMemoryIds: ["skill-1", "wm-1"],
  },
};

const capture: TurnMemoryCapture = {
  scope: "isolated",
  botId: "bot-1",
  threadId: "thread-1",
  runId: "run-1",
  startedAt: "2026-11-04T10:00:00.000Z",
  completedAt: "2026-11-04T10:00:05.000Z",
  sequence: 12,
  query: "What is the probe code?",
  answer: "ZEBRA-4471-QUOKKA",
  toolCalls: [{ name: "search_history", input: '{"q":"probe"}' }],
  toolResults: [{ name: "search_history", output: "1 hit" }],
  sourceMemoryIds: ["skill-1"],
};

beforeEach(() => {
  resetMemmyCircuitBreakers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("prepareMemmyConnection", () => {
  it("requires the operator's private-endpoint authorization", async () => {
    await expect(prepareMemmyConnection(settings, credentials)).rejects.toBeInstanceOf(
      MemoryProviderPrivateEndpointRequiredError,
    );
    await expect(
      prepareMemmyConnection(settings, credentials, { allowPrivateEndpoint: false }),
    ).rejects.toBeInstanceOf(MemoryProviderPrivateEndpointRequiredError);
  });

  it("normalizes the base URL and keeps only known fields", async () => {
    await expect(
      prepareMemmyConnection(
        { baseUrl: " http://127.0.0.1:8080/ ", contextBudget: "1200", extra: "dropped" },
        { token: "  test-token-not-real  " },
        { allowPrivateEndpoint: true },
      ),
    ).resolves.toEqual({
      settings: {
        baseUrl: "http://127.0.0.1:8080",
        endpointTrust: "private",
        contextBudget: "1200",
      },
      credentials: { token: "test-token-not-real" },
    });
  });

  it("pins a private hostname to private addresses", async () => {
    const resolveHostname = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    await expect(
      prepareMemmyConnection({ baseUrl: "http://memory.example.com:8080" }, credentials, {
        allowPrivateEndpoint: true,
        resolveHostname,
      }),
    ).resolves.toMatchObject({ settings: { baseUrl: "http://memory.example.com:8080" } });
    expect(resolveHostname).toHaveBeenCalledWith("memory.example.com");

    const publicAnswer = vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]);
    await expect(
      prepareMemmyConnection({ baseUrl: "http://memory.example.com:8080" }, credentials, {
        allowPrivateEndpoint: true,
        resolveHostname: publicAnswer,
      }),
    ).rejects.toThrow();
  });

  it("accepts a public HTTPS endpoint without private authorization and drops a stale trust field", async () => {
    await expect(
      prepareMemmyConnection(
        { baseUrl: "https://memory.example.com/", endpointTrust: "private" },
        credentials,
        { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      ),
    ).resolves.toEqual({
      settings: { baseUrl: "https://memory.example.com" },
      credentials: { token: "test-token-not-real" },
    });
  });

  it("reclassifies a public-looking name that resolves to the server network", async () => {
    const privateAnswer = async () => [{ address: "127.0.0.1", family: 4 }];
    await expect(
      prepareMemmyConnection({ baseUrl: "https://memory.example.com" }, credentials, {
        allowPrivateEndpoint: false,
        resolveHostname: privateAnswer,
      }),
    ).rejects.toBeInstanceOf(MemoryProviderPrivateEndpointRequiredError);
    await expect(
      prepareMemmyConnection({ baseUrl: "https://memory.example.com" }, credentials, {
        allowPrivateEndpoint: true,
        resolveHostname: privateAnswer,
      }),
    ).resolves.toMatchObject({
      settings: { baseUrl: "https://memory.example.com", endpointTrust: "private" },
    });
  });

  it.each([
    [{ baseUrl: "" }, credentials, "baseUrl is required"],
    [{ baseUrl: "ftp://127.0.0.1" }, credentials, "HTTP(S)"],
    [{ baseUrl: "http://user:pw@127.0.0.1:8080" }, credentials, "HTTP(S)"],
    [{ baseUrl: "http://127.0.0.1:8080?x=1" }, credentials, "HTTP(S)"],
    [settings, { token: "  " }, "token is required"],
    [{ ...settings, contextBudget: "-1" }, credentials, "contextBudget"],
    [{ ...settings, contextBudget: "abc" }, credentials, "contextBudget"],
    [{ ...settings, ownerId: "has space" }, credentials, "ownerId"],
  ])("rejects %j", async (badSettings, badCredentials, message) => {
    await expect(
      prepareMemmyConnection(badSettings, badCredentials, { allowPrivateEndpoint: true }),
    ).rejects.toThrow(message);
  });

  it("refuses metadata targets", async () => {
    await expect(
      prepareMemmyConnection({ baseUrl: "http://169.254.169.254" }, credentials, {
        allowPrivateEndpoint: true,
      }),
    ).rejects.toThrow();
  });
});

describe("createMemmyTurnMemory.beforeTurn", () => {
  const recallRequest = {
    query: "  What is the probe code?  ",
    scope: "isolated" as const,
    botId: "bot-1",
    threadId: "thread-1",
    runId: "run-1",
  };

  it("searches every layer for this bot and thread and returns raw sections", async () => {
    const fetchImpl = vi.fn(async () => json(searchReply));
    const memory = createMemmyTurnMemory(settings, credentials, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(memory.beforeTurn(recallRequest, context)).resolves.toEqual({
      sections: [
        { layer: "procedure", id: "s-1", sourceMemoryIds: ["skill-1"], content: "Do X then Y." },
        {
          layer: "environment",
          id: "s-2",
          sourceMemoryIds: ["wm-1"],
          content: "Prod is read-only.",
        },
      ],
      sourceMemoryIds: ["skill-1", "wm-1"],
    });
    const body = bodyOf(fetchImpl);
    expect(body).toMatchObject({
      query: "What is the probe code?",
      layers: ["Skill", "L2", "L3", "L1"],
      limit: 8,
      contextBudget: 1800,
      includeInjectedContext: true,
      verbose: true,
      namespace: {
        source: "rakazo",
        userId: "owner-1",
        profileId: "bot:bot-1",
        sessionKey: "thread-1",
      },
    });
    expect(typeof body.requestId).toBe("string");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("recalls the Space before the bot in shared scope and merges the answers", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const profileId = JSON.parse(String(init?.body)).namespace.profileId;
      return json(
        profileId === "space:space-1"
          ? {
              debug: {
                sections: [
                  { id: "s-2", memoryLayer: "L3", memoryIds: ["wm-1"], content: "Shared fact." },
                ],
                sourceMemoryIds: ["wm-1"],
              },
            }
          : searchReply,
      );
    });
    const memory = createMemmyTurnMemory(settings, credentials, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      memory.beforeTurn({ ...recallRequest, scope: "shared" }, context),
    ).resolves.toEqual({
      sections: [
        { layer: "environment", id: "s-2", sourceMemoryIds: ["wm-1"], content: "Shared fact." },
        { layer: "procedure", id: "s-1", sourceMemoryIds: ["skill-1"], content: "Do X then Y." },
      ],
      sourceMemoryIds: ["wm-1", "skill-1"],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const sharedCapture = memmyCaptureBody(
      { ...capture, scope: "shared" },
      { ownerId: settings.ownerId, spaceId: context.spaceId },
    );
    expect(bodyOf(fetchImpl, 0).namespace).toEqual({
      source: "rakazo",
      userId: "owner-1",
      profileId: "space:space-1",
      sessionKey: sharedCapture.sourceTurn.conversationId,
    });
    expect(bodyOf(fetchImpl, 1).namespace).toEqual({
      source: "rakazo",
      userId: "owner-1",
      profileId: "bot:bot-1",
      sessionKey: "thread-1",
    });
  });

  it("prefers the request's budget over the configured one", async () => {
    const fetchImpl = vi.fn(async () => json(searchReply));
    const memory = createMemmyTurnMemory({ ...settings, contextBudget: "900" }, credentials, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await memory.beforeTurn(recallRequest, context);
    await memory.beforeTurn({ ...recallRequest, contextBudget: 400 }, context);
    expect(bodyOf(fetchImpl, 0).contextBudget).toBe(900);
    expect(bodyOf(fetchImpl, 1).contextBudget).toBe(400);
  });

  it("returns null for empty results, failures and a blank query, and never throws", async () => {
    const replies: Array<() => Response> = [
      () => json({ injectedContext: "", debug: { sections: [], sourceMemoryIds: [] } }),
      () => json({}, 500),
      () => {
        throw new Error("socket hang up");
      },
    ];
    const fetchImpl = vi.fn(async () => (replies.shift() as () => Response)());
    const memory = createMemmyTurnMemory(settings, credentials, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(memory.beforeTurn(recallRequest, context)).resolves.toBeNull();
    await expect(memory.beforeTurn(recallRequest, context)).resolves.toBeNull();
    await expect(memory.beforeTurn(recallRequest, context)).resolves.toBeNull();
    await expect(
      memory.beforeTurn({ ...recallRequest, query: "   " }, context),
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns null at the 1.5s budget", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const memory = createMemmyTurnMemory(settings, credentials, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const pending = memory.beforeTurn(recallRequest, context);
    await vi.advanceTimersByTimeAsync(MEMMY_SEARCH_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
  });

  it("skips Memmy while the breaker is open", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => json({}, 502));
    const memory = createMemmyTurnMemory(settings, credentials, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(memory.beforeTurn(recallRequest, context)).resolves.toBeNull();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("createMemmyTurnMemory.captureTurn", () => {
  it("posts the source-turn body field for field", async () => {
    const fetchImpl = vi.fn(async () => json({ status: "stored" }));
    const memory = createMemmyTurnMemory(settings, credentials, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(memory.captureTurn(capture, context)).resolves.toEqual({ status: "stored" });
    expect(urlOf(fetchImpl)).toBe("http://127.0.0.1:8080/api/v1/source-turns/complete");
    const body = bodyOf(fetchImpl);
    expect(typeof body.requestId).toBe("string");
    expect({ ...body, requestId: "<uuid>" }).toEqual({
      requestId: "<uuid>",
      channel: "hook",
      source: "rakazo",
      namespace: { userId: "owner-1" },
      sourceTurn: {
        source: "rakazo",
        profileId: "bot:bot-1",
        conversationId: "thread-1",
        turnId: "run-1",
        startedAt: "2026-11-04T10:00:00.000Z",
        completedAt: "2026-11-04T10:00:05.000Z",
        sequence: 12,
        completionEvidence: "run.completed",
      },
      query: "What is the probe code?",
      answer: "ZEBRA-4471-QUOKKA",
      status: "succeeded",
      toolCalls: [{ name: "search_history", input: '{"q":"probe"}' }],
      toolResults: [{ name: "search_history", output: "1 hit" }],
      sourceMemoryIds: ["skill-1"],
    });
  });

  it("writes a shared-scope turn once, to the Space's profile", async () => {
    const fetchImpl = vi.fn(async () => json({ status: "stored" }));
    const memory = createMemmyTurnMemory(settings, credentials, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await memory.captureTurn({ ...capture, scope: "shared" }, context);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(bodyOf(fetchImpl)).toMatchObject({
      namespace: { userId: "owner-1" },
      sourceTurn: {
        profileId: "space:space-1",
        conversationId: 'thread-bot:v1:["thread-1","bot-1"]',
      },
    });
  });

  it("separates shared source conversations by both thread and bot without changing the profile", () => {
    const target = { ownerId: "owner-1", spaceId: "space-1" };
    const turns = [
      { threadId: "thread-1", botId: "bot-1" },
      { threadId: "thread-1", botId: "bot-2" },
      { threadId: "thread-2", botId: "bot-1" },
    ].map(
      (identity) =>
        memmyCaptureBody({ ...capture, ...identity, scope: "shared" }, target).sourceTurn,
    );
    expect(turns.map((turn) => turn.profileId)).toEqual([
      "space:space-1",
      "space:space-1",
      "space:space-1",
    ]);
    expect(turns.map((turn) => turn.conversationId)).toEqual([
      'thread-bot:v1:["thread-1","bot-1"]',
      'thread-bot:v1:["thread-1","bot-2"]',
      'thread-bot:v1:["thread-2","bot-1"]',
    ]);
  });

  it("keeps shared identity components distinct when ids contain the delimiter", () => {
    const target = { ownerId: "owner-1", spaceId: "space-1" };
    const left = memmyCaptureBody(
      { ...capture, scope: "shared", threadId: "a:b", botId: "c" },
      target,
    );
    const right = memmyCaptureBody(
      { ...capture, scope: "shared", threadId: "a", botId: "b:c" },
      target,
    );
    expect(left.sourceTurn.conversationId).toBe('thread-bot:v1:["a:b","c"]');
    expect(right.sourceTurn.conversationId).toBe('thread-bot:v1:["a","b:c"]');
    expect(left.sourceTurn.conversationId).not.toBe(right.sourceTurn.conversationId);
  });

  it("omits sequence when the capture has none and defaults the owner", () => {
    const { sequence: _omit, ...withoutSequence } = capture;
    const body = memmyCaptureBody(
      withoutSequence,
      { ownerId: "rakazo", spaceId: "space-1" },
      "req-fixed",
    );
    expect(body.requestId).toBe("req-fixed");
    expect(body.namespace).toEqual({ userId: "rakazo" });
    expect("sequence" in body.sourceTurn).toBe(false);
  });

  it.each(["isolated", "shared"] as const)(
    "builds the same content for a replay of the same stored %s turn",
    (scope) => {
      const target = { ownerId: "owner-1", spaceId: "space-1" };
      const storedCapture = { ...capture, scope };
      const first = memmyCaptureBody(storedCapture, target, "a");
      const second = memmyCaptureBody(structuredClone(storedCapture), target, "b");
      expect({ ...first, requestId: "" }).toEqual({ ...second, requestId: "" });
    },
  );

  it("passes Memmy's classification through and turns throws into retryable", async () => {
    const replies: Array<() => Response> = [
      () => json({ status: "existing" }),
      () => json({ status: "conflict", reason: "source_turn_content_conflict" }),
      () => json({}, 401),
      () => {
        throw new TypeError("fetch failed");
      },
    ];
    const fetchImpl = vi.fn(async () => (replies.shift() as () => Response)());
    const memory = createMemmyTurnMemory({ baseUrl: settings.baseUrl }, credentials, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(memory.captureTurn(capture, context)).resolves.toEqual({ status: "existing" });
    await expect(memory.captureTurn(capture, context)).resolves.toEqual({
      status: "terminal",
      reason: "source_turn_content_conflict",
    });
    await expect(memory.captureTurn(capture, context)).resolves.toEqual({
      status: "retryable",
      reason: "unauthorized",
    });
    await expect(memory.captureTurn(capture, context)).resolves.toEqual({
      status: "retryable",
      reason: "network_error",
    });
    expect(bodyOf(fetchImpl).namespace).toEqual({ userId: "rakazo" });
  });
});

describe("createMemmyProvider", () => {
  it("describes itself as the memmy provider with shared scope", () => {
    const description = createMemmyProvider(settings, credentials).describe();
    expect(description.id).toBe(MEMMY_PROVIDER_ID);
    expect(description.capabilities.sharedScope).toBe(true);
  });

  it("backs shared scope with the Space's profile for recall and save", async () => {
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).endsWith("/add") ? json({ id: "m-1" }) : json(searchReply),
    );
    const provider = createMemmyProvider(settings, credentials, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const recalled = await provider.recall(
      { query: "probe", scope: "shared", botId: "bot-1", limit: 5 },
      context,
    );
    // Both profiles return the same sections; duplicates are dropped.
    expect(recalled).toEqual({
      ok: true,
      value: [
        { memory: "Do X then Y.", score: 1, id: "s-1" },
        { memory: "Prod is read-only.", score: 1, id: "s-2" },
      ],
    });
    expect([bodyOf(fetchImpl, 0), bodyOf(fetchImpl, 1)].map((b) => b.namespace)).toEqual([
      { source: "rakazo", userId: "owner-1", profileId: "space:space-1" },
      { source: "rakazo", userId: "owner-1", profileId: "bot:bot-1" },
    ]);
    await provider.save(
      { content: "Team uses CSV.", scope: "shared", botId: "bot-1", source: { kind: "durable" } },
      context,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(bodyOf(fetchImpl, 2).namespace).toEqual({
      source: "rakazo",
      userId: "owner-1",
      profileId: "space:space-1",
    });
  });

  it("recalls sections as semantic results", async () => {
    const fetchImpl = vi.fn(async () => json(searchReply));
    const provider = createMemmyProvider(settings, credentials, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      provider.recall({ query: "probe", scope: "isolated", botId: "bot-1", limit: 5 }, context),
    ).resolves.toEqual({
      ok: true,
      value: [
        { memory: "Do X then Y.", score: 1, id: "s-1" },
        { memory: "Prod is read-only.", score: 1, id: "s-2" },
      ],
    });
    expect(bodyOf(fetchImpl)).toMatchObject({
      layers: ["Skill", "L2", "L3", "L1"],
      limit: 5,
      contextBudget: 1800,
      namespace: { source: "rakazo", userId: "owner-1", profileId: "bot:bot-1" },
    });
    expect((bodyOf(fetchImpl).namespace as Record<string, unknown>).sessionKey).toBeUndefined();
  });

  it("reports recall failures as provider errors", async () => {
    const fetchImpl = vi.fn(async () => json({}, 500));
    const provider = createMemmyProvider(settings, credentials, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      provider.recall({ query: "probe", scope: "isolated", botId: "bot-1", limit: 5 }, context),
    ).resolves.toEqual({ ok: false, error: "Memmy recall failed: http_500" });
  });

  it("saves durable facts as L2 and keeps history summaries out of Memmy", async () => {
    const fetchImpl = vi.fn(async () => json({ id: "m-1" }));
    const provider = createMemmyProvider(settings, credentials, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      provider.save(
        {
          content: " Prefers CSV. ",
          scope: "isolated",
          botId: "bot-1",
          source: { kind: "durable" },
        },
        context,
      ),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(urlOf(fetchImpl)).toBe("http://127.0.0.1:8080/api/v1/memory/add");
    expect(bodyOf(fetchImpl)).toMatchObject({
      content: "Prefers CSV.",
      layer: "L2",
      tags: ["rakazo", "durable"],
      namespace: { source: "rakazo", userId: "owner-1", profileId: "bot:bot-1" },
    });

    await expect(
      provider.save(
        {
          content: "summary",
          scope: "isolated",
          botId: "bot-1",
          source: { kind: "history", generation: 3 },
        },
        context,
      ),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      provider.purgeHistory({ botId: "bot-1", generations: [3] }, context),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(provider.forget).toBeUndefined();
  });
});
