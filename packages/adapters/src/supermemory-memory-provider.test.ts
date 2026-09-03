import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupermemoryMemoryProvider } from "./supermemory-memory-provider.js";

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
    expect(
      fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).containerTag),
    ).toEqual(["rakazo:workspace:workspace-1", "rakazo:bot-1"]);
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

    expect(
      fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).containerTag),
    ).toEqual(["rakazo:bot-1", "rakazo:bot-1:history:3"]);
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

    expect(
      fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).containerTag),
    ).toEqual(["rakazo:workspace:workspace-1", "rakazo:bot-1"]);
  });

  it("purges only requested history generations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await provider().purgeHistory({ botId: "bot-1", generations: [2, 3, 3] }, context);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:6767/v3/container-tags/rakazo%3Abot-1%3Ahistory%3A2",
      "http://localhost:6767/v3/container-tags/rakazo%3Abot-1%3Ahistory%3A3",
    ]);
  });
});
