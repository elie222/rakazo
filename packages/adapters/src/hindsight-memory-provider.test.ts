import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HindsightMemoryProvider,
  prepareHindsightConnection,
} from "./hindsight-memory-provider.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

function provider(
  overrides: Partial<ConstructorParameters<typeof HindsightMemoryProvider>[0]> = {},
) {
  return new HindsightMemoryProvider({
    baseUrl: "http://127.0.0.1:8892",
    bank: "life",
    allowWrites: true,
    readScope: "bank",
    ...overrides,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe("HindsightMemoryProvider", () => {
  it("recalls the whole bank in bank mode and maps the results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        results: [
          {
            id: "fact-1",
            text: "The owner prefers short answers.",
            scores: { final: 0.82 },
            mentioned_at: "2026-10-01T00:00:00Z",
          },
          { id: "fact-2", text: "   " },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider().recall(
      { query: "owner preferences", scope: "shared", botId: "bot-1", limit: 5 },
      context,
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:8892/v1/default/banks/life/memories/recall",
    );
    const body = requestBody(fetchMock, 0);
    expect(body.query).toBe("owner preferences");
    expect(body.tags).toBeUndefined();
    expect(result).toEqual({
      ok: true,
      value: [
        {
          memory: "The owner prefers short answers.",
          score: 0.82,
          id: "fact-1",
          updatedAt: "2026-10-01T00:00:00Z",
          provenance: "hindsight bank:life",
        },
      ],
    });
  });

  it("narrows recall to the bot's own writes in bot mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await provider({ readScope: "bot" }).recall(
      { query: "project", scope: "shared", botId: "bot-1", limit: 3 },
      context,
    );

    expect(requestBody(fetchMock, 0).tags).toEqual(["rakazo:bot:bot-1"]);
  });

  it("sends nothing for a blank query", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider().recall(
      { query: "  ", scope: "shared", botId: "bot-1", limit: 3 },
      context,
    );

    expect(result).toEqual({ ok: true, value: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains a durable fact with attribution tags and metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({}));
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider().save(
      {
        content: "Prefers terse replies.",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );

    expect(result).toEqual({ ok: true, value: undefined });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:8892/v1/default/banks/life/memories/",
    );
    const body = requestBody(fetchMock, 0);
    expect(body.async).toBe(false);
    expect(body.items).toEqual([
      {
        content: "Prefers terse replies.",
        context: "rakazo",
        document_id: "rakazo-space-1-bot-1",
        tags: ["rakazo:space:space-1", "rakazo:bot:bot-1"],
        metadata: { rakazoSpace: "space-1", rakazoBot: "bot-1", rakazoScope: "shared" },
      },
    ]);
  });

  it("keeps compaction summaries out of the shared bank", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider().save(
      {
        content: "summary",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "history", generation: 2 },
      },
      context,
    );

    expect(result).toEqual({ ok: true, value: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to write when writing is off", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider({ allowWrites: false }).save(
      { content: "x", scope: "shared", botId: "bot-1", source: { kind: "durable" } },
      context,
    );

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes the bank and returns normalized settings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await prepareHindsightConnection(
      { baseUrl: "http://127.0.0.1:8892/", bank: "life" },
      {},
      { fetch: fetchMock as unknown as typeof globalThis.fetch },
    );

    expect(prepared.settings).toEqual({
      baseUrl: "http://127.0.0.1:8892/",
      bank: "life",
      allowWrites: "true",
      readScope: "bank",
    });
    expect(prepared.credentials).toEqual({ token: "" });
  });

  it("fails the connection when the bank does not answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ detail: "nope" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareHindsightConnection(
        { baseUrl: "http://127.0.0.1:8892", bank: "life" },
        {},
        {
          fetch: fetchMock as unknown as typeof globalThis.fetch,
        },
      ),
    ).rejects.toThrow(/Hindsight answered 500/);
  });
});
