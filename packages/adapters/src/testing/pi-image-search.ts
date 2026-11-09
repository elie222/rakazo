import { zstdDecompressSync } from "node:zlib";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { vi } from "vitest";
import { builtinAgentTools } from "../builtin-tools.js";
import { resolveRuntimeModel } from "../pi-runtime-models.js";
import type { ToolHost } from "../pi-runtime-tools.js";

const accountId = "image-search-test-account";
function fakeToken(suffix = "fake-signature") {
  const claims = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_compute_residency: "eu",
    },
  };
  return `fake-header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${suffix}`;
}

const image = (name: string) => ({
  type: "image_result",
  image_url: `https://images.example.com/${name}.jpg`,
  source_website_url: `https://example.com/photos/${name}`,
  caption: `Photo ${name}`,
  thumbnail_url: `https://images.example.com/${name}-small.jpg`,
});
const searchItem = (results: unknown[], id = "search-1", status = "completed") => ({
  type: "response.output_item.done",
  output_index: 0,
  item: { id, type: "web_search_call", status, results },
});
const terminal = {
  type: "response.completed",
  response: {
    id: "response-test",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 12,
      output_tokens: 3,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 1 },
    },
  },
};
const textItem = {
  id: "text-1",
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "Invented prose https://example.com/not-a-result.jpg" }],
};
const prose = [
  { type: "response.output_item.added", output_index: 1, item: { ...textItem, content: [] } },
  {
    type: "response.content_part.added",
    output_index: 1,
    content_index: 0,
    part: textItem.content[0],
  },
  {
    type: "response.output_text.delta",
    output_index: 1,
    content_index: 0,
    delta: "Invented prose",
  },
  { type: "response.output_item.done", output_index: 1, item: textItem },
];
const sse = (events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

function hostFor(fetch: typeof globalThis.fetch, request?: AgentRunRequest) {
  const token = fakeToken();
  const config = {
    provider: "openai-codex",
    id: "gpt-5.1-codex",
    oauth: {
      credential: {
        type: "oauth" as const,
        access: token,
        refresh: "fake-refresh",
        expires: Date.now() + 3_600_000,
        accountId,
      },
      persist: vi.fn(async () => undefined),
      retire: vi.fn(async () => false),
    },
  };
  const resolved = resolveRuntimeModel(config);
  if (!resolved.model) throw new Error("Installed Pi subscription model is missing");
  const events: AgentRuntimeEvent[] = [];
  const controller = new AbortController();
  const observer = {
    beforeCall: vi.fn(async () => "reservation-test"),
    afterCall: vi.fn(async () => undefined),
    onRequestId: vi.fn(async () => undefined),
  };
  const executeTool = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>();
  const onUsage = vi.fn(async (usage: Parameters<NonNullable<AgentRunRequest["onUsage"]>>[0]) => {
    await request?.onUsage?.(usage);
  });
  const gateImageSearch = vi.fn<NonNullable<AgentRunRequest["gateImageSearch"]>>((args, _id, run) =>
    run(args),
  );
  const host: ToolHost = {
    request: {
      botId: "bot-test",
      threadId: "thread-test",
      runId: "run-test",
      model: config,
      prompt: "Find existing photos",
      instructions: "test",
      history: [],
      tools: builtinAgentTools,
      executeTool,
      gateImageSearch,
      ...request,
      onUsage,
    },
    activeModel: { ...resolved, model: resolved.model, config },
    models: resolved.models,
    model: resolved.model,
    apiKey: undefined,
    modelFetch: fetch,
    modelCallObserver: observer,
    context: { userId: "user-test" },
    queue: {
      push: (event) => events.push(event),
      fail: () => undefined,
      close: () => undefined,
      async *iterate() {},
    },
    signal: controller.signal,
    nestedAgents: new Set(),
    subagentGate: { acquire: async () => undefined, release: () => undefined },
    toolCallBudget: { count: 0, exceeded: false, limit: 0, inFlight: 0 },
    toolCallSeq: { value: 0 },
    abortTurn: vi.fn(),
    depth: 0,
    pausePending: false,
    pendingShells: [],
  };
  return { host, events, token, observer, controller, executeTool, gateImageSearch, onUsage };
}

function fixtureFetch(events: unknown[]) {
  return vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(sse(events), {
        headers: { "content-type": "text/event-stream", "x-request-id": "request-test" },
      }),
  );
}

async function requestBody(call: Parameters<typeof globalThis.fetch>) {
  const request = new Request(...call);
  const bytes = Buffer.from(await request.arrayBuffer());
  const decoded =
    request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
  return JSON.parse(decoded.toString());
}

export {
  accountId,
  fakeToken,
  fixtureFetch,
  hostFor,
  image,
  prose,
  requestBody,
  searchItem,
  sse,
  terminal,
};
