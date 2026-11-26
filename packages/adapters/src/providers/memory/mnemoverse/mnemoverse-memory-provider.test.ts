import { createHash } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MNEMOVERSE_BASE_URL } from "./mnemoverse-client.js";
import {
  createMnemoverseProvider,
  MnemoverseMemoryProvider,
  prepareMnemoverseConnection,
} from "./mnemoverse-memory-provider.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

const key = "mk_test_key_123";
const BOT = "rakazo:bot:bot-1";
const SPACE = "rakazo:space:space-1";

interface Atom {
  id: string;
  domain: string;
  content: string;
}

/** A Mnemoverse that holds atoms, answers reads by domain, and records what it was asked. */
function mnemoverse(atoms: Atom[] = [], overrides: Record<string, () => Response> = {}) {
  const calls: Array<{ method: string; path: string; body: unknown; headers: Headers }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const full = String(url);
    expect(full.startsWith(MNEMOVERSE_BASE_URL)).toBe(true);
    const path = full.slice(MNEMOVERSE_BASE_URL.length);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, headers: new Headers(init?.headers) });
    expect(init?.redirect).toBe("error");
    const override = overrides[`${method} ${path}`];
    if (override) return override();
    if (method === "GET" && path === "/memory/stats") return Response.json({});
    if (method === "POST" && path === "/memory/read") {
      const items = atoms
        .filter((atom) => atom.domain === body.domain)
        .map((atom, index) => ({
          atom_id: atom.id,
          content: atom.content,
          relevance: 0.9 - index / 10,
          domain: atom.domain,
        }));
      return Response.json({ items });
    }
    if (method === "POST" && path === "/memory/write") {
      atoms.push({ id: `atom-${atoms.length + 1}`, domain: body.domain, content: body.content });
      return Response.json({ stored: true, atom_id: `atom-${atoms.length}` });
    }
    const atomPath = path.match(/^\/memory\/atoms\/(.+)$/);
    if (atomPath) {
      const index = atoms.findIndex((atom) => atom.id === decodeURIComponent(atomPath[1]!));
      if (index < 0) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
      if (method === "GET") return Response.json({ atom_id: atoms[index]!.id, ...atoms[index] });
      atoms.splice(index, 1);
      return Response.json({ deleted: 1 });
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { atoms, calls, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

const provider = () => new MnemoverseMemoryProvider({ apiKey: key });
const recallOf = (scope: "isolated" | "shared", query = "coffee") =>
  provider().recall({ query, scope, botId: "bot-1", limit: 5 }, context);

describe("Mnemoverse recall", () => {
  it("reads only the bot's own domain when isolated", async () => {
    const { calls } = mnemoverse([
      { id: "a", domain: BOT, content: "Likes tea" },
      { id: "b", domain: SPACE, content: "Space fact" },
    ]);
    const result = await recallOf("isolated");
    expect(result).toEqual({
      ok: true,
      value: [{ memory: "Likes tea", score: 0.9, id: "a", provenance: "mnemoverse", entity: BOT }],
    });
    expect(calls.map((call) => call.body)).toEqual([{ query: "coffee", domain: BOT, top_k: 5 }]);
    expect(calls[0]?.headers.get("X-Api-Key")).toBe(key);
  });

  it("sends the query without the spaces around it", async () => {
    const { calls } = mnemoverse();
    await recallOf("isolated", "  coffee  ");
    expect(calls.map((call) => (call.body as { query: string }).query)).toEqual(["coffee"]);
  });

  it("reads the Space's shared domain and the bot's own when shared", async () => {
    const { calls } = mnemoverse([
      { id: "a", domain: BOT, content: "Likes tea" },
      { id: "b", domain: SPACE, content: "Team uses UTC" },
      { id: "c", domain: "rakazo:space:space-2", content: "Another Space" },
    ]);
    const result = await recallOf("shared");
    expect(result.ok && result.value.map((item) => item.id).sort()).toEqual(["a", "b"]);
    expect(calls.map((call) => (call.body as { domain: string }).domain).sort()).toEqual([
      BOT,
      SPACE,
    ]);
  });

  it("sorts by relevance, keeps one copy of an atom and honours the limit", async () => {
    mnemoverse([], {
      "POST /memory/read": () =>
        Response.json({
          items: [
            { atom_id: "low", content: "low", relevance: 0.1, domain: BOT },
            { atom_id: "high", content: "high", relevance: 0.8, domain: BOT },
            { atom_id: "high", content: "high", relevance: 0.8, domain: BOT },
            { atom_id: "mid", content: "mid", relevance: 0.5, domain: BOT },
          ],
        }),
    });
    const result = await provider().recall(
      { query: "q", scope: "isolated", botId: "bot-1", limit: 2 },
      context,
    );
    expect(result.ok && result.value.map((item) => item.id)).toEqual(["high", "mid"]);
  });

  it("lists a fact saved in both domains once and never returns more than the cap", async () => {
    const atoms = [
      { id: "own", domain: BOT, content: "Team uses UTC" },
      { id: "shared", domain: SPACE, content: "Team uses UTC" },
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `fact-${index}`,
        domain: index % 2 ? BOT : SPACE,
        content: `Fact ${index}`,
      })),
    ];
    mnemoverse(atoms);
    const result = await provider().recall(
      { query: "q", scope: "shared", botId: "bot-1", limit: 50 },
      context,
    );
    const memories = result.ok ? result.value.map((item) => item.memory) : [];
    expect(memories.filter((memory) => memory === "Team uses UTC")).toHaveLength(1);
    expect(memories).toHaveLength(20);
  });

  it("skips replaced revisions, blank content and malformed rows", async () => {
    mnemoverse([], {
      "POST /memory/read": () =>
        Response.json({
          items: [
            { atom_id: "old", content: "Old", relevance: 0.9, domain: BOT, superseded_by: "new" },
            { atom_id: "blank", content: "  ", relevance: 0.9, domain: BOT },
            { content: "no id", domain: BOT },
            null,
            { atom_id: "new", content: "New", domain: BOT },
          ],
        }),
    });
    const result = await recallOf("isolated");
    expect(result).toEqual({
      ok: true,
      value: [{ memory: "New", score: 0, id: "new", provenance: "mnemoverse", entity: BOT }],
    });
  });

  it("answers an empty or blank query without calling the service", async () => {
    const { fetchMock } = mnemoverse();
    expect(await recallOf("shared", "")).toEqual({ ok: true, value: [] });
    expect(await recallOf("shared", "   ")).toEqual({ ok: true, value: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still recalls from one domain when the other fails", async () => {
    mnemoverse([{ id: "b", domain: SPACE, content: "Team uses UTC" }]);
    let reads = 0;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith("/memory/read") && JSON.parse(String(init?.body)).domain === BOT) {
        reads++;
        return new Response("{}", { status: 500 });
      }
      return base(url, init);
    });
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const result = await recallOf("shared");
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    expect(reads).toBe(1);
    expect(result.ok && result.value.map((item) => item.id)).toEqual(["b"]);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.level).toBe("warn");
    expect(JSON.stringify(sink.events[0])).toContain("Mnemoverse recall failed: 500");
    expect(JSON.stringify(sink.events[0])).toContain(BOT);
  });

  it("fails when every domain fails, whether the service answered or threw", async () => {
    mnemoverse([], { "POST /memory/read": () => new Response("{}", { status: 429 }) });
    const returned = await recallOf("shared");
    expect(returned.ok).toBe(false);
    expect(!returned.ok && returned.error).toContain("429");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const thrown = await recallOf("shared");
    expect(thrown.ok).toBe(false);
    expect(!thrown.ok && thrown.error).toContain("network down");
  });

  it("fails on a body that is not JSON instead of recalling nothing", async () => {
    mnemoverse([], { "POST /memory/read": () => new Response("<html>", { status: 200 }) });
    expect((await recallOf("isolated")).ok).toBe(false);
  });

  it("fails on an answer without an items list, but not on an empty one", async () => {
    for (const body of [{}, null, { items: "none" }, { items: null }]) {
      mnemoverse([], { "POST /memory/read": () => Response.json(body) });
      expect((await recallOf("isolated")).ok).toBe(false);
    }
    mnemoverse([], { "POST /memory/read": () => new Response(null, { status: 204 }) });
    expect((await recallOf("isolated")).ok).toBe(false);
    mnemoverse([], { "POST /memory/read": () => Response.json({ items: [] }) });
    expect(await recallOf("isolated")).toEqual({ ok: true, value: [] });
  });

  it("drops an item the service returns from a domain that was not asked for", async () => {
    mnemoverse([], {
      "POST /memory/read": () =>
        Response.json({
          items: [
            { atom_id: "own", content: "Likes tea", relevance: 0.5, domain: BOT },
            { atom_id: "other", content: "Not yours", relevance: 0.9, domain: "rakazo:bot:bot-2" },
          ],
        }),
    });
    const result = await recallOf("isolated");
    expect(result.ok && result.value.map((item) => item.id)).toEqual(["own"]);
  });
});

describe("Mnemoverse save", () => {
  it("writes an isolated memory to the bot's domain", async () => {
    const { calls } = mnemoverse();
    const result = await provider().save(
      { content: " Likes tea ", scope: "isolated", botId: "bot-1", source: { kind: "durable" } },
      context,
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(calls[0]?.body).toEqual({ content: "Likes tea", domain: BOT });
  });

  const sharedSave = {
    content: "Team uses UTC",
    scope: "shared" as const,
    botId: "bot-1",
    source: { kind: "durable" as const },
  };

  it("writes a shared memory only to the Space's domain", async () => {
    const { calls } = mnemoverse();
    expect(await provider().save(sharedSave, context)).toEqual({ ok: true, value: undefined });
    expect(calls.map((call) => call.body)).toEqual([{ content: "Team uses UTC", domain: SPACE }]);
  });

  it("keeps a shared fact out of Isolated recall and each scope's own memories in place", async () => {
    mnemoverse();
    await provider().save(
      { content: "Likes tea", scope: "isolated", botId: "bot-1", source: { kind: "durable" } },
      context,
    );
    await provider().save(sharedSave, context);

    const isolated = await recallOf("isolated");
    expect(isolated.ok && isolated.value.map((item) => item.memory)).toEqual(["Likes tea"]);

    const shared = await recallOf("shared");
    expect(shared.ok && shared.value.map((item) => item.memory).sort()).toEqual([
      "Likes tea",
      "Team uses UTC",
    ]);
  });

  it("reports a failed shared save instead of calling it partly saved", async () => {
    mnemoverse([], { "POST /memory/write": () => new Response("{}", { status: 500 }) });
    const result = await provider().save(sharedSave, context);
    expect(!result.ok && result.error).toContain("500");
  });

  it("counts an exact duplicate as saved", async () => {
    mnemoverse([], {
      "POST /memory/write": () =>
        Response.json({ stored: false, reason: "exact_duplicate", duplicate_of: "x" }),
    });
    expect(await provider().save(sharedSave, context)).toEqual({ ok: true, value: undefined });
  });

  it("refuses content over the service limit without calling it", async () => {
    const { fetchMock } = mnemoverse();
    const result = await provider().save(
      { ...sharedSave, scope: "isolated", content: `${"a".repeat(10_000)}b` },
      context,
    );
    expect(!result.ok && result.error).toContain("10000");
    expect(fetchMock).not.toHaveBeenCalled();
    const exact = await provider().save(
      { ...sharedSave, scope: "isolated", content: "a".repeat(10_000) },
      context,
    );
    expect(exact.ok).toBe(true);
  });

  it("keeps compaction summaries out of the service", async () => {
    const { fetchMock } = mnemoverse();
    const result = await provider().save(
      {
        content: "Summary",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "history", generation: 2 },
      },
      context,
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(
      await provider().purgeHistory({ botId: "bot-1", threadId: "t", generations: [1] }, context),
    ).toEqual({ ok: true, value: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses blank content without calling the service", async () => {
    const { fetchMock } = mnemoverse();
    const result = await provider().save(
      { content: "  ", scope: "isolated", botId: "bot-1", source: { kind: "durable" } },
      context,
    );
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a write the service declined for another reason instead of counting it as saved", async () => {
    mnemoverse([], {
      "POST /memory/write": () =>
        Response.json({
          stored: false,
          atom_id: null,
          reason: "below importance threshold",
        }),
    });
    const result = await provider().save(
      { content: "Likes tea", scope: "isolated", botId: "bot-1", source: { kind: "durable" } },
      context,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("below importance threshold");
  });

  it("does not wait on a response body that will not close", async () => {
    const controller = new AbortController();
    // The abort lands only once the cancel has started and will never settle.
    const stuck = new ReadableStream({
      cancel: () => {
        controller.abort();
        return new Promise<void>(() => {});
      },
    });
    mnemoverse([], { "POST /memory/read": () => new Response(stuck, { status: 500 }) });
    const result = await provider().recall(
      { query: "coffee", scope: "isolated", botId: "bot-1", limit: 5 },
      { ...context, signal: controller.signal },
    );
    expect(result.ok).toBe(false);
  });

  it("does not count a successful answer that never says the fact was stored", async () => {
    const request = {
      content: "Likes tea",
      scope: "isolated" as const,
      botId: "bot-1",
      source: { kind: "durable" as const },
    };
    for (const answer of [
      () => Response.json({}),
      () => Response.json(null),
      () => Response.json({ stored: "yes" }),
      () => new Response(null, { status: 204 }),
    ]) {
      mnemoverse([], { "POST /memory/write": answer });
      expect((await provider().save(request, context)).ok).toBe(false);
    }
    mnemoverse([], { "POST /memory/write": () => Response.json({}) });
    const shared = await provider().save({ ...request, scope: "shared" }, context);
    expect(shared.ok).toBe(false);
  });

  it("reports a rejected write and a thrown one the same way", async () => {
    const request = {
      content: "Likes tea",
      scope: "isolated" as const,
      botId: "bot-1",
      source: { kind: "durable" as const },
    };
    mnemoverse([], { "POST /memory/write": () => new Response("{}", { status: 500 }) });
    const returned = await provider().save(request, context);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const thrown = await provider().save(request, context);
    expect(returned.ok).toBe(false);
    expect(thrown.ok).toBe(false);
    expect(!returned.ok && returned.error).toMatch(/^Mnemoverse save failed/);
    expect(!thrown.ok && thrown.error).toMatch(/^Mnemoverse save failed/);
  });

  it("shortens a domain name past the 100 character limit and keeps it stable", async () => {
    const { calls } = mnemoverse();
    const longBot = "b".repeat(120);
    const save = () =>
      provider().save(
        { content: "x", scope: "isolated", botId: longBot, source: { kind: "durable" } },
        { ...context, botId: longBot },
      );
    await save();
    await save();
    const domains = calls.map((call) => (call.body as { domain: string }).domain);
    const domain = domains[0];
    expect(domain).toBe(`rakazo:bot:${createHash("sha256").update(longBot).digest("hex")}`);
    expect(domain?.length).toBeLessThanOrEqual(100);
    expect(domains[1]).toBe(domain);
  });
});

const ATOM_A = "00000000-0000-4000-8000-00000000000a";
const ATOM_B = "00000000-0000-4000-8000-00000000000b";
const ATOM_OTHER = "00000000-0000-4000-8000-0000000000c1";
const ATOM_FOREIGN = "00000000-0000-4000-8000-0000000000c2";

describe("Mnemoverse forget", () => {
  const forget = (
    id: string,
    scope: "isolated" | "shared" = "isolated",
    extra: { entity?: string } = {},
  ) => provider().forget({ id, scope, botId: "bot-1", reason: "asked", ...extra }, context);

  it("deletes a memory in the bot's domain", async () => {
    const { atoms, calls } = mnemoverse([{ id: ATOM_A, domain: BOT, content: "Likes tea" }]);
    expect(await forget(ATOM_A, "isolated", { entity: BOT })).toEqual({
      ok: true,
      value: { id: ATOM_A, expired: true, reason: "asked" },
    });
    expect(atoms).toEqual([]);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /memory/atoms/${ATOM_A}`,
      `DELETE /memory/atoms/${ATOM_A}`,
    ]);
  });

  it("deletes a shared Space memory only for a shared bot", async () => {
    mnemoverse([{ id: ATOM_B, domain: SPACE, content: "Team uses UTC" }]);
    const isolated = await forget(ATOM_B, "isolated");
    expect(isolated.ok).toBe(false);
    expect((await forget(ATOM_B, "shared")).ok).toBe(true);
  });

  it("will not delete a memory that sits in another bot's or Space's domain", async () => {
    const { atoms, calls } = mnemoverse([
      { id: ATOM_OTHER, domain: "rakazo:bot:bot-2", content: "Not yours" },
      { id: ATOM_FOREIGN, domain: "personal-notes", content: "Not Rakazo's" },
    ]);
    expect((await forget(ATOM_OTHER, "shared")).ok).toBe(false);
    expect((await forget(ATOM_FOREIGN, "shared")).ok).toBe(false);
    expect(atoms).toHaveLength(2);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("refuses a citation from another domain before asking the service", async () => {
    const { fetchMock } = mnemoverse([{ id: ATOM_A, domain: BOT, content: "Likes tea" }]);
    const result = await forget(ATOM_A, "isolated", { entity: "rakazo:bot:bot-2" });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an unknown id and a blank id as failures", async () => {
    const { calls } = mnemoverse();
    expect((await forget("  ")).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("counts a forget as done when the memory is already gone, so a retry succeeds", async () => {
    const { calls, atoms } = mnemoverse([{ id: ATOM_A, domain: BOT, content: "x" }]);
    expect((await forget(ATOM_A)).ok).toBe(true);
    expect(atoms).toHaveLength(0);
    const retried = await forget(ATOM_A);
    expect(retried).toEqual({ ok: true, value: { id: ATOM_A, expired: true, reason: "asked" } });
    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE", "GET"]);
  });

  it("fails closed when the lookup cannot be completed", async () => {
    const { calls } = mnemoverse([{ id: ATOM_A, domain: BOT, content: "x" }], {
      [`GET /memory/atoms/${ATOM_A}`]: () => new Response("{}", { status: 500 }),
    });
    expect((await forget(ATOM_A)).ok).toBe(false);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("fails closed when the lookup does not say which domain the atom is in", async () => {
    const { calls } = mnemoverse([{ id: ATOM_A, domain: BOT, content: "x" }], {
      [`GET /memory/atoms/${ATOM_A}`]: () => Response.json({ atom_id: ATOM_A }),
    });
    expect((await forget(ATOM_A)).ok).toBe(false);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("reports a failed delete and a thrown one as failures", async () => {
    mnemoverse([{ id: ATOM_A, domain: BOT, content: "x" }], {
      [`DELETE /memory/atoms/${ATOM_A}`]: () => new Response("{}", { status: 403 }),
    });
    const returned = await forget(ATOM_A);
    expect(returned.ok).toBe(false);

    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method === "DELETE") throw new Error("reset");
      return base(url, init);
    });
    const thrown = await forget(ATOM_A);
    expect(thrown.ok).toBe(false);
    expect(!thrown.ok && thrown.error).toContain("reset");
  });

  it("counts a delete as done when the atom is already gone", async () => {
    mnemoverse([{ id: ATOM_A, domain: BOT, content: "x" }], {
      [`DELETE /memory/atoms/${ATOM_A}`]: () => Response.json({ deleted: 0 }),
    });
    expect((await forget(ATOM_A)).ok).toBe(true);
  });

  it("refuses an id that is not a UUID before any request", async () => {
    const { fetchMock } = mnemoverse([{ id: ATOM_A, domain: BOT, content: "x" }]);
    for (const id of ["..", ".", "a/b?c", "not-an-id"]) expect((await forget(id)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Mnemoverse connection", () => {
  it("checks the key and keeps only the trimmed key", async () => {
    const { calls } = mnemoverse();
    await expect(
      prepareMnemoverseConnection({ stray: "x" }, { apiKey: `  ${key}  `, extra: "y" }),
    ).resolves.toEqual({ settings: {}, credentials: { apiKey: key } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("X-Api-Key")).toBe(key);
  });

  it("rejects a missing or short key before calling the service", async () => {
    const { fetchMock } = mnemoverse();
    await expect(prepareMnemoverseConnection({}, {})).rejects.toThrow("apiKey is required");
    await expect(prepareMnemoverseConnection({}, { apiKey: "  " })).rejects.toThrow(
      "apiKey is required",
    );
    await expect(prepareMnemoverseConnection({}, { apiKey: "short" })).rejects.toThrow(
      "at least 8",
    );
    const error = await prepareMnemoverseConnection({}, { apiKey: "mk_live_abc\ndef" }).catch(
      (caught: Error) => caught,
    );
    expect((error as Error).message).toBe("apiKey must be printable text without spaces");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says when the key is rejected and when the service is unreachable", async () => {
    mnemoverse([], { "GET /memory/stats": () => new Response("{}", { status: 401 }) });
    await expect(prepareMnemoverseConnection({}, { apiKey: key })).rejects.toThrow(
      "Mnemoverse rejected the API key: 401",
    );
    mnemoverse([], { "GET /memory/stats": () => new Response("{}", { status: 503 }) });
    await expect(prepareMnemoverseConnection({}, { apiKey: key })).rejects.toThrow(
      "Mnemoverse connection check failed: 503",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(prepareMnemoverseConnection({}, { apiKey: key })).rejects.toThrow("offline");
  });

  it("makes no call when a provider is created", () => {
    const { fetchMock } = mnemoverse();
    expect(createMnemoverseProvider({}, { apiKey: key }).describe().id).toBe("mnemoverse");
    expect(() => createMnemoverseProvider({}, {})).toThrow("apiKey is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Mnemoverse emoji limits", () => {
  it("does not cut an emoji in half in the recall query", async () => {
    const { calls } = mnemoverse();
    await recallOf("isolated", `${"q".repeat(4999)}😀 tail`);
    expect(calls.map((call) => (call.body as { query: string }).query)).toEqual(["q".repeat(4999)]);
  });

  it("does not cut an emoji in half in a recalled memory", async () => {
    mnemoverse([{ id: "a", domain: BOT, content: `${"m".repeat(9999)}😀 tail` }]);
    const result = await recallOf("isolated");
    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({ memory: "m".repeat(9999) })],
    });
  });
});
