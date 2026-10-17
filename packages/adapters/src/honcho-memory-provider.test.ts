import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { HonchoMemoryProvider } from "./honcho-memory-provider.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

function honchoFetch(chatAnswers: Record<string, string>) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const peer = path.match(/\/peers\/([^/]+)\/chat$/)?.[1];
    const body = peer ? { content: chatAnswers[decodeURIComponent(peer)] ?? "" } : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function provider(fetch: typeof globalThis.fetch) {
  return new HonchoMemoryProvider(
    { baseUrl: "https://api.honcho.dev", apiKey: "hch-test", reasoningLevel: "low", fetch },
    {},
  );
}

function calls(fetchMock: ReturnType<typeof honchoFetch>) {
  return fetchMock.mock.calls.map(([url, init]) => ({
    path: new URL(String(url)).pathname,
    body: JSON.parse(String(init?.body)),
  }));
}

describe("HonchoMemoryProvider", () => {
  it("saves shared facts for the user and the bot, then recalls through peer chat", async () => {
    const fetchMock = honchoFetch({
      "user-user-1": "The user's favorite color is teal.",
      "bot-bot-1": "NO_RELEVANT_MEMORY",
    });
    const memory = provider(fetchMock);

    const saved = await memory.save(
      {
        content: "Favorite color is teal",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );
    const recalled = await memory.recall(
      { query: "what color should the deck be?", scope: "shared", botId: "bot-1", limit: 5 },
      context,
    );

    expect(saved).toEqual({ ok: true, value: undefined });
    const conclusions = calls(fetchMock).find((call) => call.path.endsWith("/conclusions"));
    expect(conclusions).toEqual({
      path: "/v3/workspaces/rakazo-space-1/conclusions",
      body: {
        conclusions: [
          {
            content: "Favorite color is teal",
            observer_id: "bot-bot-1",
            observed_id: "user-user-1",
          },
          {
            content: "Favorite color is teal",
            observer_id: "user-user-1",
            observed_id: "user-user-1",
          },
        ],
      },
    });
    const chats = calls(fetchMock).filter((call) => call.path.endsWith("/chat"));
    expect(chats.map((call) => [call.path, call.body.target])).toEqual([
      ["/v3/workspaces/rakazo-space-1/peers/user-user-1/chat", undefined],
      ["/v3/workspaces/rakazo-space-1/peers/bot-bot-1/chat", "user-user-1"],
    ]);
    expect(recalled).toEqual({
      ok: true,
      value: [
        {
          memory: "The user's favorite color is teal.",
          score: 1,
          provenance: "honcho",
          entity: "user-user-1",
        },
      ],
    });
    // Workspace and peers are get-or-create once per provider, not per call.
    expect(calls(fetchMock).filter((call) => call.path.endsWith("/peers"))).toHaveLength(2);
  });

  it("keeps compaction summaries out of Honcho", async () => {
    const fetchMock = honchoFetch({});
    const result = await provider(fetchMock).save(
      {
        content: "summary",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "history", generation: 1 },
      },
      context,
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
