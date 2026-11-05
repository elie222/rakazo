import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemmySearchInput, MemmySourceTurnBody } from "./memmy-memory-client.js";
import {
  classifyCaptureResponse,
  MEMMY_BREAKER_COOLDOWN_MS,
  MEMMY_CAPTURE_TIMEOUT_MS,
  MEMMY_SEARCH_TIMEOUT_MS,
  MemmyMemoryClient,
  resetMemmyCircuitBreakers,
} from "./memmy-memory-client.js";
import type { ResolveHostname } from "./network-address.js";

const BASE_URL = "http://127.0.0.1:8080";
const TOKEN = "test-token-not-real";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Never settles on its own; rejects when the request signal aborts, as fetch does. */
function hangingFetch(): typeof fetch {
  return vi.fn(
    (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  ) as unknown as typeof fetch;
}

/** Loopback is private: the local-service transport hands it straight to the fetch seam. */
function client(fetchImpl: typeof fetch, now?: () => number) {
  return new MemmyMemoryClient({
    baseUrl: BASE_URL,
    token: TOKEN,
    endpointTrust: "private",
    fetch: fetchImpl,
    ...(now ? { now } : {}),
  });
}

const PUBLIC_BASE_URL = "https://memory.example.com";

function publicClient(fetchImpl: typeof fetch, resolveHostname: ResolveHostname) {
  return new MemmyMemoryClient({
    baseUrl: PUBLIC_BASE_URL,
    token: TOKEN,
    endpointTrust: "public",
    fetch: fetchImpl,
    resolveHostname,
  });
}

const namespace = {
  source: "rakazo",
  userId: "owner-1",
  profileId: "bot:bot-1",
  sessionKey: "thread-1",
};

const searchInput: MemmySearchInput = {
  query: "how do I reconcile invoices?",
  layers: ["procedure", "policy", "environment", "episode"],
  limit: 8,
  contextBudget: 1800,
  namespaces: [namespace],
};

const verboseResponse = {
  injectedContext: "# Memory\n...",
  debug: {
    searchEventId: "se-1",
    sections: [
      {
        id: "sec-skill",
        title: "Reconcile",
        kind: "skill",
        memoryLayer: "Skill",
        memoryIds: ["skill-1"],
        content: "1. Export. 2. Match.",
        tokenEstimate: 12,
      },
      {
        id: "sec-user",
        title: "User",
        kind: "user_memory",
        memoryLayer: "UserMemory",
        memoryIds: ["um-1"],
        content: "Prefers CSV.",
      },
    ],
    sourceMemoryIds: ["skill-1", "um-1", "l1-9"],
  },
};

const captureBody: MemmySourceTurnBody = {
  requestId: "req-c",
  channel: "hook",
  source: "rakazo",
  namespace: { userId: "owner-1" },
  sourceTurn: {
    source: "rakazo",
    profileId: "bot-1",
    conversationId: "thread-1",
    turnId: "run-1",
    startedAt: "2026-11-04T10:00:00.000Z",
    completedAt: "2026-11-04T10:00:05.000Z",
    completionEvidence: "run.completed",
  },
  query: "q",
  answer: "a",
  status: "succeeded",
  toolCalls: [],
  toolResults: [],
  sourceMemoryIds: [],
};

beforeEach(() => {
  resetMemmyCircuitBreakers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MemmyMemoryClient.search", () => {
  it("posts the verbose search with Memmy's layer names and maps sections back to the contract", async () => {
    const fetchImpl = vi.fn(async () => json(verboseResponse));
    const result = await client(fetchImpl as unknown as typeof fetch).search(searchInput);
    expect(result).toEqual({
      ok: true,
      value: {
        // UserMemory has no contract layer, so it never reaches the prompt.
        sections: [
          {
            layer: "procedure",
            id: "sec-skill",
            sourceMemoryIds: ["skill-1"],
            content: "1. Export. 2. Match.",
          },
        ],
        sourceMemoryIds: ["skill-1", "um-1", "l1-9"],
      },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/v1/memory/search`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      requestId: expect.any(String),
      query: "how do I reconcile invoices?",
      layers: ["Skill", "L2", "L3", "L1"],
      limit: 8,
      contextBudget: 1800,
      includeInjectedContext: true,
      verbose: true,
      namespace,
    });
  });

  it("maps each contract layer to its Memmy name on the request", async () => {
    const fetchImpl = vi.fn(async () => json(verboseResponse));
    await client(fetchImpl as unknown as typeof fetch).search({
      ...searchInput,
      layers: ["episode", "policy"],
    });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body)).layers).toEqual(["L1", "L2"]);
  });

  it("searches several namespaces in parallel and merges them in order without duplicates", async () => {
    const replies: Record<string, unknown> = {
      "space:space-1": {
        debug: {
          sections: [
            { id: "shared", memoryLayer: "L2", memoryIds: ["m-1"], content: "space policy" },
          ],
          sourceMemoryIds: ["m-1"],
        },
      },
      "bot:bot-1": {
        debug: {
          sections: [
            { id: "shared", memoryLayer: "L2", memoryIds: ["m-1"], content: "duplicate" },
            { id: "own", memoryLayer: "Skill", memoryIds: ["m-2"], content: "bot procedure" },
          ],
          sourceMemoryIds: ["m-1", "m-2"],
        },
      },
    };
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const profile = JSON.parse(String(init.body)).namespace.profileId as string;
      return json(replies[profile]);
    });
    const result = await client(fetchImpl as unknown as typeof fetch).search({
      ...searchInput,
      namespaces: [
        { ...namespace, profileId: "space:space-1" },
        { ...namespace, profileId: "bot:bot-1" },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const ids = fetchImpl.mock.calls.map(
      ([, init]) => JSON.parse(String(init.body)).requestId as string,
    );
    expect(new Set(ids).size).toBe(2);
    expect(result).toEqual({
      ok: true,
      value: {
        sections: [
          { layer: "policy", id: "shared", sourceMemoryIds: ["m-1"], content: "space policy" },
          { layer: "procedure", id: "own", sourceMemoryIds: ["m-2"], content: "bot procedure" },
        ],
        sourceMemoryIds: ["m-1", "m-2"],
      },
    });
  });

  it("counts a multi-namespace search as one breaker failure", async () => {
    const fetchImpl = vi.fn(async () => json({}, 503));
    const memmy = client(fetchImpl as unknown as typeof fetch);
    const twoNamespaces = {
      ...searchInput,
      namespaces: [namespace, { ...namespace, profileId: "space:space-1" }],
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await memmy.search(twoNamespaces)).toEqual({ ok: false, error: "http_503" });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(await memmy.search(twoNamespaces)).toEqual({ ok: false, error: "http_503" });
    expect(await memmy.search(twoNamespaces)).toEqual({ ok: false, error: "circuit_open" });
  });

  it("fails the whole search when one namespace fails", async () => {
    const replies = [json(verboseResponse), json({}, 500)];
    const fetchImpl = vi.fn(async () => replies.shift() as Response);
    const result = await client(fetchImpl as unknown as typeof fetch).search({
      ...searchInput,
      namespaces: [namespace, { ...namespace, profileId: "space:space-1" }],
    });
    expect(result).toEqual({ ok: false, error: "http_500" });
  });

  it("falls back to the sections' memory ids, deduplicated, without debug.sourceMemoryIds", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        injectedContext: "",
        debug: {
          sections: [
            { id: "a", memoryLayer: "L2", memoryIds: ["p-1", "p-2"], content: "policy" },
            { id: "b", memoryLayer: "L1", memoryIds: ["p-2", "t-1"], content: "trace" },
            { id: "c", memoryLayer: "L9", memoryIds: ["x-1"], content: "future layer" },
            { id: "d", memoryLayer: "L1", memoryIds: ["e-1"], content: "   " },
          ],
        },
      }),
    );
    const result = await client(fetchImpl as unknown as typeof fetch).search(searchInput);
    expect(result).toEqual({
      ok: true,
      value: {
        sections: [
          { layer: "policy", id: "a", sourceMemoryIds: ["p-1", "p-2"], content: "policy" },
          { layer: "episode", id: "b", sourceMemoryIds: ["p-2", "t-1"], content: "trace" },
        ],
        sourceMemoryIds: ["p-1", "p-2", "t-1"],
      },
    });
  });

  it("retains each section's valid memory ids without substituting its section id or global sources", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        debug: {
          sections: [
            {
              id: "section-a",
              memoryLayer: "L2",
              memoryIds: ["m-1", "m-1", 7, ""],
              content: "policy",
            },
            { id: "section-b", memoryLayer: "L1", content: "fact" },
          ],
          sourceMemoryIds: ["reported-only"],
        },
      }),
    );
    expect(await client(fetchImpl as unknown as typeof fetch).search(searchInput)).toEqual({
      ok: true,
      value: {
        sections: [
          { layer: "policy", id: "section-a", sourceMemoryIds: ["m-1"], content: "policy" },
          { layer: "episode", id: "section-b", sourceMemoryIds: [], content: "fact" },
        ],
        sourceMemoryIds: ["reported-only"],
      },
    });
  });

  it("treats a missing debug block, bad JSON and non-2xx as failures", async () => {
    const responses = [
      json({ injectedContext: "only markdown" }),
      new Response("not json", { status: 200 }),
      json({ error: "boom" }, 500),
    ];
    const fetchImpl = vi.fn(async () => responses.shift() as Response);
    const memmy = client(fetchImpl as unknown as typeof fetch);
    expect(await memmy.search(searchInput)).toEqual({ ok: false, error: "invalid_response" });
    expect(await memmy.search(searchInput)).toEqual({ ok: false, error: "invalid_json" });
    expect(await memmy.search(searchInput)).toEqual({ ok: false, error: "http_500" });
  });

  it("gives up at the search budget even when the transport hangs", async () => {
    vi.useFakeTimers();
    const pending = client(hangingFetch()).search(searchInput);
    await vi.advanceTimersByTimeAsync(MEMMY_SEARCH_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, error: "timeout" });
  });

  it("opens the breaker after three failures and probes again after the cooldown", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => json({}, 503));
    const memmy = client(fetchImpl as unknown as typeof fetch);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await memmy.search(searchInput)).toEqual({ ok: false, error: "http_503" });
    }
    expect(await memmy.search(searchInput)).toEqual({ ok: false, error: "circuit_open" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    // Another client for the same Memmy shares the breaker.
    const sibling = client(fetchImpl as unknown as typeof fetch);
    expect(await sibling.search(searchInput)).toEqual({ ok: false, error: "circuit_open" });

    await vi.advanceTimersByTimeAsync(MEMMY_BREAKER_COOLDOWN_MS - 1);
    expect(await memmy.search(searchInput)).toEqual({ ok: false, error: "circuit_open" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1);
    fetchImpl.mockImplementationOnce(async () => json(verboseResponse));
    expect((await memmy.search(searchInput)).ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    // Success closed it: a single failure no longer short-circuits.
    expect(await memmy.search(searchInput)).toEqual({ ok: false, error: "http_503" });
    fetchImpl.mockImplementationOnce(async () => json(verboseResponse));
    expect((await memmy.search(searchInput)).ok).toBe(true);
  });

  it("reopens immediately when the probe after the cooldown fails", async () => {
    let clock = 1_000;
    const fetchImpl = vi.fn(async () => json({}, 500));
    const memmy = client(fetchImpl as unknown as typeof fetch, () => clock);
    for (let attempt = 0; attempt < 3; attempt += 1) await memmy.search(searchInput);
    clock += MEMMY_BREAKER_COOLDOWN_MS;
    expect(await memmy.search(searchInput)).toEqual({ ok: false, error: "http_500" });
    expect(await memmy.search(searchInput)).toEqual({ ok: false, error: "circuit_open" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("does not count a caller abort against the breaker", async () => {
    const memmy = client(hangingFetch());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const pending = memmy.search(searchInput, controller.signal);
      controller.abort();
      expect(await pending).toEqual({ ok: false, error: "aborted" });
    }
    const fetchImpl = vi.fn(async () => json(verboseResponse));
    expect((await client(fetchImpl as unknown as typeof fetch).search(searchInput)).ok).toBe(true);
  });
});

describe("MemmyMemoryClient public endpoint", () => {
  const publicAnswer = [{ address: "203.0.113.10", family: 4 }];

  it("resolves and checks the host before sending the token", async () => {
    const fetchImpl = vi.fn(async () => json(verboseResponse));
    const resolve = vi.fn(async () => publicAnswer);
    const result = await publicClient(fetchImpl as unknown as typeof fetch, resolve).search(
      searchInput,
    );
    expect(result.ok).toBe(true);
    expect(resolve).toHaveBeenCalledWith("memory.example.com");
    expect(String(urlOf(fetchImpl))).toBe(`${PUBLIC_BASE_URL}/api/v1/memory/search`);
  });

  it.each([
    ["IPv6 loopback", [{ address: "::1", family: 6 }]],
    ["loopback", [{ address: "127.0.0.1", family: 4 }]],
    ["cloud metadata", [{ address: "169.254.169.254", family: 4 }]],
    ["a mix of public and private", [...publicAnswer, { address: "127.0.0.1", family: 4 }]],
  ])("refuses a host that resolves to %s", async (_label, addresses) => {
    const fetchImpl = vi.fn(async () => json(verboseResponse));
    const memmy = publicClient(fetchImpl as unknown as typeof fetch, async () => addresses);
    expect(await memmy.search(searchInput)).toEqual({ ok: false, error: "network_error" });
    expect(await memmy.complete(captureBody)).toEqual({
      status: "retryable",
      reason: "network_error",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks every request, so a name rebound to the server network is refused", async () => {
    const fetchImpl = vi.fn(async () => json(verboseResponse));
    const answers = [publicAnswer, [{ address: "127.0.0.1", family: 4 }]];
    const memmy = publicClient(
      fetchImpl as unknown as typeof fetch,
      async () => answers.shift() ?? [],
    );
    expect((await memmy.search(searchInput)).ok).toBe(true);
    expect(await memmy.search(searchInput)).toEqual({ ok: false, error: "network_error" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not follow a redirect", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }),
    );
    const memmy = publicClient(fetchImpl as unknown as typeof fetch, async () => publicAnswer);
    expect(await memmy.add({ ...addBody })).toEqual({
      ok: false,
      error: "Memmy save failed: network_error",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

function urlOf(fetchImpl: ReturnType<typeof vi.fn>): unknown {
  return (fetchImpl.mock.calls[0] as unknown[] | undefined)?.[0];
}

const addBody = {
  requestId: "req-a",
  content: "Prefers CSV.",
  layer: "L2" as const,
  tags: ["rakazo", "durable"],
  namespace: { source: "rakazo", userId: "owner-1", profileId: "bot:bot-1" },
};

describe("MemmyMemoryClient.complete", () => {
  it.each([
    [{ status: "stored", result: { turnId: "t" } }, { status: "stored" }],
    [{ status: "existing" }, { status: "existing" }],
    [
      { status: "conflict", reason: "source_turn_content_conflict" },
      { status: "terminal", reason: "source_turn_content_conflict" },
    ],
    [
      { status: "rejected", reason: "capture_policy" },
      { status: "terminal", reason: "capture_policy" },
    ],
    [{ status: "rejected" }, { status: "terminal", reason: "rejected" }],
    [
      { status: "pending", reason: "identity_unresolved" },
      { status: "terminal", reason: "identity_unresolved" },
    ],
    [
      { status: "pending", reason: "source_turn_boundary_unresolved" },
      { status: "terminal", reason: "source_turn_boundary_unresolved" },
    ],
    [
      { status: "pending", reason: "source_turn_incomplete" },
      { status: "terminal", reason: "source_turn_incomplete" },
    ],
    [
      { status: "pending", reason: "memory_add_disabled" },
      { status: "terminal", reason: "memory_add_disabled" },
    ],
    [
      { status: "pending", reason: "legacy_before_activation" },
      { status: "terminal", reason: "legacy_before_activation" },
    ],
    [
      { status: "pending", reason: "source_episode_closed" },
      { status: "terminal", reason: "source_episode_closed" },
    ],
    [
      { status: "pending", reason: "source_session_closed" },
      { status: "terminal", reason: "source_session_closed" },
    ],
    [
      { status: "pending", reason: "legacy_source_turn_already_completed" },
      { status: "terminal", reason: "legacy_source_turn_already_completed" },
    ],
    [
      { status: "pending", reason: "source_turn_out_of_order" },
      { status: "retryable", reason: "source_turn_out_of_order" },
    ],
    [
      { status: "pending", reason: "source_capture_activation_unresolved" },
      { status: "retryable", reason: "source_capture_activation_unresolved" },
    ],
    [{ status: "pending" }, { status: "retryable", reason: "pending" }],
    [{ status: "brand_new" }, { status: "retryable", reason: "unexpected_status:brand_new" }],
  ])("maps 200 %j to %j", async (body, expected) => {
    const fetchImpl = vi.fn(async () => json(body));
    expect(await client(fetchImpl as unknown as typeof fetch).complete(captureBody)).toEqual(
      expected,
    );
  });

  it.each([
    [401, { status: "terminal", reason: "unauthorized" }],
    [403, { status: "terminal", reason: "unauthorized" }],
    [400, { status: "terminal", reason: "rejected_400" }],
    [404, { status: "terminal", reason: "rejected_404" }],
    [422, { status: "terminal", reason: "rejected_422" }],
    [408, { status: "retryable", reason: "http_408" }],
    [425, { status: "retryable", reason: "http_425" }],
    [429, { status: "retryable", reason: "http_429" }],
    [500, { status: "retryable", reason: "http_500" }],
    [503, { status: "retryable", reason: "http_503" }],
  ])("maps HTTP %i to %j", async (status, expected) => {
    const fetchImpl = vi.fn(async () => json({ error: { code: "x" } }, status));
    expect(await client(fetchImpl as unknown as typeof fetch).complete(captureBody)).toEqual(
      expected,
    );
  });

  it("retries network errors and bad JSON, without leaking the token", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
    });
    const network = await client(failing as unknown as typeof fetch).complete(captureBody);
    expect(network).toEqual({ status: "retryable", reason: "network_error" });
    expect(JSON.stringify(network)).not.toContain(TOKEN);

    const garbled = vi.fn(async () => new Response("<html>", { status: 200 }));
    expect(await client(garbled as unknown as typeof fetch).complete(captureBody)).toEqual({
      status: "retryable",
      reason: "invalid_json",
    });
  });

  it("retries after the capture timeout", async () => {
    vi.useFakeTimers();
    const pending = client(hangingFetch()).complete(captureBody);
    await vi.advanceTimersByTimeAsync(MEMMY_CAPTURE_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: "retryable", reason: "timeout" });
  });

  it("posts the body unchanged to source-turns/complete", async () => {
    const fetchImpl = vi.fn(async () => json({ status: "stored" }));
    await client(fetchImpl as unknown as typeof fetch).complete(captureBody);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/v1/source-turns/complete`);
    expect(JSON.parse(String(init.body))).toEqual(captureBody);
  });

  it("classifies other 4xx as terminal and unexpected non-2xx as retryable", () => {
    expect(classifyCaptureResponse(409, true, {})).toEqual({
      status: "terminal",
      reason: "rejected_409",
    });
    expect(classifyCaptureResponse(413, true, {})).toEqual({
      status: "terminal",
      reason: "rejected_413",
    });
    expect(classifyCaptureResponse(304, false, null)).toEqual({
      status: "retryable",
      reason: "http_304",
    });
    expect(classifyCaptureResponse(200, true, ["stored"])).toEqual({
      status: "retryable",
      reason: "invalid_json",
    });
  });
});

describe("MemmyMemoryClient.add", () => {
  it("returns ok on 2xx and a provider error otherwise", async () => {
    const responses = [json({ id: "m-1" }), json({ error: "nope" }, 400)];
    const fetchImpl = vi.fn(async () => responses.shift() as Response);
    const memmy = client(fetchImpl as unknown as typeof fetch);
    const body = addBody;
    expect(await memmy.add(body)).toEqual({ ok: true, value: undefined });
    expect(await memmy.add(body)).toEqual({ ok: false, error: "Memmy save failed: HTTP 400" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/v1/memory/add`);
    expect(JSON.parse(String(init.body))).toEqual(body);
  });
});
