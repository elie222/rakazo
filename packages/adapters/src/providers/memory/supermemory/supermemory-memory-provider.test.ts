import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolveHostname } from "../../../network/network-address.js";
import { MemoryProviderPrivateEndpointRequiredError } from "../serenity/serenity-memory-provider.js";
import {
  MAX_MEMORY_CONTENT_CHARS,
  SUPERMEMORY_DELETE_FORBIDDEN_ERROR,
} from "./supermemory-client.js";
import {
  createSupermemoryProvider,
  prepareSupermemoryConnection,
  SupermemoryMemoryProvider,
} from "./supermemory-memory-provider.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

function provider() {
  return new SupermemoryMemoryProvider({
    baseUrl: "http://localhost:6767",
    apiKey: "sm_test_key",
  });
}

function namespaceOf(url: unknown): string {
  return decodeURIComponent(new URL(String(url)).pathname.split("/")[2] ?? "");
}

afterEach(() => vi.unstubAllGlobals());

describe("SupermemoryMemoryProvider", () => {
  it("keeps Supermemory namespaces inside the adapter and omits empty history", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await provider().recall(
      { query: "project", scope: "shared", botId: "bot-1", limit: 5 },
      context,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => namespaceOf(call[0]))).toEqual([
      "rakazo:workspace:workspace-1",
      "rakazo:bot-1",
    ]);
  });

  it("adds the current history generation only after compaction", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await provider().recall(
      {
        query: "project",
        scope: "isolated",
        botId: "bot-1",
        historyGeneration: 3,
        limit: 5,
      },
      context,
    );

    expect(fetchMock.mock.calls.map((call) => namespaceOf(call[0]))).toEqual([
      "rakazo:bot-1",
      "rakazo:bot-1:history:3",
    ]);
  });

  it("passes recall limits and cancellation through to the provider client", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await provider().recall(
      { query: "project", scope: "isolated", botId: "bot-1", limit: 2 },
      { ...context, signal: controller.signal },
    );

    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body)).limit).toBe(2);
    expect(init?.signal.aborted).toBe(true);
  });

  it("mirrors shared durable saves so a later scope change retains bot memory", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await provider().save(
      {
        content: "Use metric units.",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );

    expect(fetchMock.mock.calls.map((call) => namespaceOf(call[0]))).toEqual([
      "rakazo:workspace:workspace-1",
      "rakazo:bot-1",
    ]);
  });

  it("saves a fact at the character limit unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const content = "a".repeat(MAX_MEMORY_CONTENT_CHARS);

    await expect(
      provider().save(
        { content, scope: "isolated", botId: "bot-1", source: { kind: "durable" } },
        context,
      ),
    ).resolves.toEqual({ ok: true, value: undefined });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).content).toBe(content);
  });

  it("refuses a fact over the character limit instead of cutting it short", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provider().save(
        {
          content: "a".repeat(MAX_MEMORY_CONTENT_CHARS + 1),
          scope: "isolated",
          botId: "bot-1",
          source: { kind: "durable" },
        },
        context,
      ),
    ).resolves.toEqual({
      ok: false,
      error: `Supermemory save skipped: memory content is longer than ${MAX_MEMORY_CONTENT_CHARS} characters. Save a shorter fact.`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("purges only requested history generations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await provider().purgeHistory({ botId: "bot-1", generations: [2, 3, 3] }, context);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:6767/ns/rakazo%3Abot-1%3Ahistory%3A2",
      "http://localhost:6767/ns/rakazo%3Abot-1%3Ahistory%3A3",
    ]);
  });

  it("purges a generation that never got a container", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    await expect(
      provider().purgeHistory({ botId: "bot-1", generations: [4, 5] }, context),
    ).resolves.toEqual({ ok: true, value: undefined });
  });

  it("reports a purge the key is not allowed to make", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 403 })));
    await expect(
      provider().purgeHistory({ botId: "bot-1", generations: [4] }, context),
    ).resolves.toEqual({ ok: false, error: SUPERMEMORY_DELETE_FORBIDDEN_ERROR });
  });

  it.each(["", "  "])("recalls nothing for an empty query without searching", async (query) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      provider().recall({ query, scope: "shared", botId: "bot-1", limit: 5 }, context),
    ).resolves.toEqual({ ok: true, value: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch when a server saved as private is now a public address", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await new SupermemoryMemoryProvider({
      baseUrl: "https://203.0.113.10:6767",
      apiKey: "sm_test_key",
    }).recall({ query: "project", scope: "isolated", botId: "bot-1", limit: 1 }, context);

    expect(result).toEqual({
      ok: false,
      error: "Local mode requires a loopback or private-network address.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const WORKSPACE = "rakazo:workspace:workspace-1";
const OWN = "rakazo:bot-1";

/** An in-memory server: each namespace holds memories by id, and forgets only its own ids. */
function fakeSupermemory(namespaces: Record<string, Record<string, string>>) {
  const forgotten = new Set<string>();
  const forgets: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const [, , tag, kind, id] = new URL(url).pathname.split("/").map(decodeURIComponent);
      const memories = namespaces[tag!] ?? {};
      if (kind === "search") {
        const live = Object.entries(memories).filter(([key]) => !forgotten.has(`${tag}/${key}`));
        return json({
          results: live
            .slice(0, (JSON.parse(String(init.body)) as { limit: number }).limit)
            .map(([key, memory]) => ({ id: key, memory, similarity: 0.9 })),
        });
      }
      if (init.method === "GET") {
        const memory = memories[id!];
        return memory === undefined
          ? json({ error: "Memory not found" }, 404)
          : json({ id, memory, isForgotten: forgotten.has(`${tag}/${id}`) });
      }
      const { ids } = JSON.parse(String(init.body)) as { ids: string[] };
      const matches = ids.filter((key) => memories[key] !== undefined);
      for (const key of matches) {
        forgotten.add(`${tag}/${key}`);
        forgets.push(`${tag}/${key}`);
      }
      return json({ count: matches.length, matches, errors: [] });
    }),
  );
  return { forgets };
}

describe("Supermemory forget", () => {
  it("cites each recalled memory's id and namespace", async () => {
    fakeSupermemory({ [OWN]: { mem_a: "Prefers tea" } });
    const recalled = await provider().recall(
      { query: "tea", scope: "isolated", botId: "bot-1", limit: 5 },
      context,
    );
    expect(recalled).toEqual({
      ok: true,
      value: [{ memory: "Prefers tea", score: 0.9, id: "mem_a", entity: OWN }],
    });
  });

  it("forgets a shared fact in both namespaces, the cited copy last, and a retry is done", async () => {
    const server = fakeSupermemory({
      [WORKSPACE]: { mem_shared: "Prefers tea", mem_other: "Lives in Paris" },
      [OWN]: { mem_own: "Prefers tea" },
    });
    const forget = () =>
      provider().forget(
        { id: "mem_shared", entity: WORKSPACE, scope: "shared", botId: "bot-1", reason: "wrong" },
        context,
      );
    const done = { ok: true, value: { id: "mem_shared", expired: true, reason: "wrong" } };
    expect(await forget()).toEqual(done);
    expect(server.forgets).toEqual([`${OWN}/mem_own`, `${WORKSPACE}/mem_shared`]);
    expect(await forget()).toEqual(done);
    expect(server.forgets).toHaveLength(2);
  });

  it("does not forget a copy again while search still lists it", async () => {
    const server = fakeSupermemory({ [OWN]: { mem_a: "Prefers tea", mem_b: "Prefers tea" } });
    const search = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      String(url).endsWith("/search")
        ? Response.json({
            results: [
              { id: "mem_a", memory: "Prefers tea", similarity: 1 },
              { id: "mem_b", memory: "Prefers tea", similarity: 1 },
            ],
          })
        : search(url, init),
    );
    const result = await provider().forget(
      { id: "mem_a", scope: "isolated", botId: "bot-1" },
      context,
    );
    expect(result.ok).toBe(true);
    expect(server.forgets).toEqual([`${OWN}/mem_b`, `${OWN}/mem_a`]);
  });

  it("reports a memory Supermemory did not forget", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) =>
        Response.json(
          init.method === "DELETE"
            ? { count: 0, matches: [], errors: [{ id: "mem_h", error: "Memory not found" }] }
            : { id: "mem_h", memory: "Summary", isForgotten: false },
        ),
      ),
    );
    const result = await provider().forget(
      { id: "mem_h", entity: OWN, scope: "isolated", botId: "bot-1" },
      context,
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("never reaches the Space's shared memory from an isolated bot", async () => {
    const server = fakeSupermemory({ [WORKSPACE]: { mem_shared: "Prefers tea" } });
    const request = { id: "mem_shared", scope: "isolated" as const, botId: "bot-1" };
    expect(await provider().forget({ ...request, entity: WORKSPACE }, context)).toEqual({
      ok: false,
      error: "That memory belongs to another bot or Space.",
    });
    expect(await provider().forget(request, context)).toMatchObject({ ok: false });
    expect(server.forgets).toEqual([]);
  });

  it("refuses another bot's namespace, chat history and a malformed id before calling Supermemory", async () => {
    const server = fakeSupermemory({});
    const request = { scope: "shared" as const, botId: "bot-1" };
    for (const entity of ["rakazo:bot-2", "rakazo:bot-2:history:1", "rakazo:bot-1:history:2"]) {
      expect((await provider().forget({ ...request, id: "mem_a", entity }, context)).ok).toBe(
        false,
      );
    }
    expect((await provider().forget({ ...request, id: "../x" }, context)).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(server.forgets).toEqual([]);
  });
});

const credentials = { apiKey: "sm_test_key" };
const privateResolver = async () => [{ address: "172.18.0.4", family: 4 as const }];
const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

describe("Supermemory connection identity", () => {
  const cloud = { mode: "cloud" };
  const identity = (
    settings: Record<string, string>,
    apiKey = "sm_test_key",
    connectionVersion: string | undefined = "connection-1",
  ) => createSupermemoryProvider(settings, { apiKey }, connectionVersion).connectionIdentity;

  it("lets a failed purge be retried on the same saved connection", () => {
    expect(identity(cloud)).toEqual(expect.any(String));
    expect(identity(cloud)).toBe(identity(cloud, "sm_rotated_key"));
    expect(createSupermemoryProvider(cloud, { apiKey: "sm_test_key" }).connectionIdentity).toBe(
      undefined,
    );
  });

  it("changes when the connection or its endpoint is replaced", () => {
    expect(identity(cloud, undefined, "connection-2")).not.toBe(identity(cloud));
    expect(identity({ mode: "local", baseUrl: "http://localhost:6767" })).not.toBe(identity(cloud));
  });
});

describe("Supermemory connection setup", () => {
  function setupFetch(deleteStatus: number) {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      init?.method === "DELETE"
        ? new Response("{}", { status: deleteStatus })
        : Response.json(
            { namespaces: [] },
            { status: new URL(String(url)).pathname.endsWith("/namespaces") ? 200 : 404 },
          ),
    );
  }

  it("checks that the key may delete memory without deleting real data", async () => {
    const fetchMock = setupFetch(404);
    vi.stubGlobal("fetch", fetchMock);
    await prepareSupermemoryConnection({ mode: "cloud" }, credentials);
    expect(fetchMock.mock.calls.map(([url, init]) => [init?.method, String(url)])).toEqual([
      ["GET", "https://api.supermemory.ai/namespaces?limit=1"],
      [
        "DELETE",
        expect.stringMatching(
          /^https:\/\/api\.supermemory\.ai\/ns\/rakazo%3Adelete-probe%3A[0-9a-f-]{36}$/,
        ),
      ],
    ]);
  });

  it("rejects a key that cannot delete memory from cleared conversations", async () => {
    vi.stubGlobal("fetch", setupFetch(403));
    await expect(prepareSupermemoryConnection({ mode: "cloud" }, credentials)).rejects.toThrow(
      SUPERMEMORY_DELETE_FORBIDDEN_ERROR,
    );
  });
});

describe("Supermemory local base URL", () => {
  it("accepts loopback", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response("[]"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await prepareSupermemoryConnection(
      { mode: "local", baseUrl: "http://127.0.0.1:6767" },
      credentials,
      { allowPrivateEndpoint: true },
    );

    expect(prepared.settings).toEqual({ mode: "local", baseUrl: "http://127.0.0.1:6767" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:6767/namespaces?limit=1");
  });

  it.each(["http://10.0.0.8:6767", "http://192.168.1.20:6767", "http://[fd00::1]:6767"])(
    "accepts private literal %s for the deployment owner",
    async (baseUrl) => {
      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response("[]"),
      );
      vi.stubGlobal("fetch", fetchMock);

      const prepared = await prepareSupermemoryConnection({ mode: "local", baseUrl }, credentials, {
        allowPrivateEndpoint: true,
      });

      expect(prepared.settings.baseUrl).toBe(baseUrl);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${baseUrl}/namespaces?limit=1`);
    },
  );

  it("accepts a Compose service name that resolves to a private address", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response("[]"),
    );
    const resolveHostname = vi.fn(privateResolver);

    const prepared = await prepareSupermemoryConnection(
      { mode: "local", baseUrl: "http://supermemory:6767" },
      credentials,
      { allowPrivateEndpoint: true, resolveHostname, fetch: fetchMock },
    );

    expect(prepared.settings).toEqual({ mode: "local", baseUrl: "http://supermemory:6767" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://supermemory:6767/namespaces?limit=1");
    expect(resolveHostname).toHaveBeenCalledOnce();
  });

  it("accepts Docker Desktop and private-suffix hosts that resolve privately", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response("[]"),
    );

    await prepareSupermemoryConnection(
      { mode: "local", baseUrl: "http://host.docker.internal:6767" },
      credentials,
      {
        allowPrivateEndpoint: true,
        resolveHostname: async () => [{ address: "192.168.65.254", family: 4 as const }],
        fetch: fetchMock,
      },
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://host.docker.internal:6767/namespaces?limit=1",
    );
  });

  it("connects a public HTTPS host without the private-endpoint setting, pinned", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response("[]"),
    );
    const resolveHostname = vi.fn(publicResolver);

    const prepared = await prepareSupermemoryConnection(
      { mode: "local", baseUrl: "https://memory.example.com" },
      credentials,
      { allowPrivateEndpoint: false, resolveHostname, fetch: fetchMock },
    );

    expect(prepared.settings).toEqual({
      mode: "local",
      baseUrl: "https://memory.example.com",
      endpointTrust: "public",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://memory.example.com/namespaces?limit=1",
    );
    expect(resolveHostname).toHaveBeenCalledOnce();
  });

  it("rejects a public host over plain HTTP", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "http://example.com:6767" },
        credentials,
        { allowPrivateEndpoint: true, resolveHostname: publicResolver },
      ),
    ).rejects.toThrow(/HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a Compose name that resolves to a public address as public", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "http://supermemory:6767" },
        credentials,
        { allowPrivateEndpoint: true, resolveHostname: publicResolver },
      ),
    ).rejects.toThrow(/HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects the Supermemory Cloud URL as a local endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "https://api.supermemory.ai" },
        credentials,
        { allowPrivateEndpoint: true, resolveHostname: privateResolver },
      ),
    ).rejects.toThrow(/Cloud URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects cloud metadata and link-local targets", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "http://169.254.169.254/latest/meta-data/" },
        credentials,
        { allowPrivateEndpoint: true },
      ),
    ).rejects.toThrow(/blocked address/);
    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "https://nas.local:6767" },
        credentials,
        {
          allowPrivateEndpoint: true,
          resolveHostname: async () => [{ address: "169.254.170.2", family: 4 as const }],
        },
      ),
    ).rejects.toThrow(/blocked address/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects private endpoints for a non-owner before any probe", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const resolveHostname = vi.fn(privateResolver);

    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "http://10.0.0.8:6767" },
        credentials,
        { allowPrivateEndpoint: false, resolveHostname },
      ),
    ).rejects.toBeInstanceOf(MemoryProviderPrivateEndpointRequiredError);
    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "http://supermemory:6767" },
        credentials,
        { allowPrivateEndpoint: false, resolveHostname },
      ),
    ).rejects.toBeInstanceOf(MemoryProviderPrivateEndpointRequiredError);
    // A public-looking name is private when it resolves privately.
    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "https://memory.example.com" },
        credentials,
        { allowPrivateEndpoint: false, resolveHostname },
      ),
    ).rejects.toBeInstanceOf(MemoryProviderPrivateEndpointRequiredError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["http://127.0.0.1:6767", "http://localhost:6767", "http://[::1]:6767"])(
    "rejects loopback %s for a non-owner before any probe",
    async (baseUrl) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        prepareSupermemoryConnection({ mode: "local", baseUrl }, credentials, {
          allowPrivateEndpoint: false,
        }),
      ).rejects.toBeInstanceOf(MemoryProviderPrivateEndpointRequiredError);
      await expect(
        prepareSupermemoryConnection({ mode: "local", baseUrl }, credentials),
      ).rejects.toBeInstanceOf(MemoryProviderPrivateEndpointRequiredError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("Supermemory private host reuse", () => {
  function privateProvider(resolveHostname: ResolveHostname, fetchImpl: typeof globalThis.fetch) {
    return new SupermemoryMemoryProvider({
      baseUrl: "http://supermemory:6767",
      apiKey: "sm_test_key",
      resolveHostname,
      fetch: fetchImpl,
    });
  }

  it("resolves a private hostname once for multi-tag recall, save, and purge", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const resolveHostname = vi.fn(privateResolver);
    const memory = privateProvider(resolveHostname, fetchMock);

    await expect(
      memory.recall({ query: "project", scope: "shared", botId: "bot-1", limit: 5 }, context),
    ).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolveHostname).toHaveBeenCalledOnce();

    resolveHostname.mockRejectedValue(new Error("dns blip"));
    await expect(
      memory.recall({ query: "project", scope: "isolated", botId: "bot-1", limit: 1 }, context),
    ).resolves.toMatchObject({ ok: true });
    await memory.save(
      {
        content: "Use metric units.",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );
    await memory.purgeHistory({ botId: "bot-1", generations: [1] }, context);

    expect(resolveHostname).toHaveBeenCalledOnce();
  });

  it("retries a private hostname after a failed lookup", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const resolveHostname = vi
      .fn()
      .mockRejectedValueOnce(new Error("eai_again"))
      .mockResolvedValue([{ address: "172.18.0.4", family: 4 as const }]);
    const memory = privateProvider(resolveHostname, fetchMock);

    await expect(
      memory.recall({ query: "project", scope: "isolated", botId: "bot-1", limit: 1 }, context),
    ).resolves.toEqual({
      ok: false,
      error: "Memory base URL did not resolve to an address.",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      memory.recall({ query: "project", scope: "isolated", botId: "bot-1", limit: 1 }, context),
    ).resolves.toMatchObject({ ok: true });
    expect(resolveHostname).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
