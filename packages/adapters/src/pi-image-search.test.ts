import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { executeImageSearch, supportsModelImageSearch } from "./pi-image-search.js";
import { MODEL_STREAM_IDLE_TIMEOUT_MS, TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";
import { describeToolActivity, toAgentTools } from "./pi-runtime-tools.js";
import { READ_ONLY_AGENT_TOOLS, selectBuiltinToolsForRun } from "./run-tool-selection.js";

import {
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
} from "./testing/pi-image-search.js";

describe("Pi image search through the installed provider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
  });

  it.each([true, false])(
    "keeps whole image/source pairs within the result budget, current: %s",
    async (current) => {
      const entries = Array.from({ length: 10 }, (_, index) => ({
        ...image(String(index)),
        image_url: `https://images.example.com/${index}/${"a".repeat(4000)}`,
        source_website_url: `https://example.com/${index}/${"b".repeat(4000)}`,
        thumbnail_url: `https://images.example.com/${index}/${"c".repeat(4000)}`,
        caption: "x".repeat(500),
      }));
      const { host } = hostFor(fixtureFetch([searchItem(entries), terminal]));
      if (current) host.request.contextStrategy = "current";
      const tool = toAgentTools(builtinAgentTools, host).find(
        (entry) => entry.name === "image_search",
      )!;
      const result = await tool.execute("long-links", { query: "harbor", maxResults: 10 });
      const content = result.content[0];
      if (content?.type !== "text") throw new Error("Missing structured result");
      expect(content.text.length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_LIMIT);
      const parsed = JSON.parse(content.text);
      expect(parsed).toEqual(result.details);
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0]).toMatchObject({
        imageUrl: entries[0]!.image_url,
        sourceUrl: entries[0]!.source_website_url,
      });
    },
  );

  it.each([false, true])(
    "records scrubbed failure diagnostics without exposing them to the model, reservation: %s",
    async (reservation) => {
      const sink = createTestSink();
      installLogger(createLogger({ service: "test", sinks: [sink] }));
      const query = "private-query-content";
      const secret = "owner-private-value";
      const fetch = fixtureFetch([
        {
          type: "response.failed",
          response: { error: { message: `quota exhausted ${secret} ${query}` } },
        },
      ]);
      const { host, observer, token } = hostFor(fetch);
      host.request.secrets = [secret];
      if (reservation)
        observer.beforeCall.mockRejectedValue(
          new Error(`quota exhausted ${secret} ${query} ${token}`),
        );
      await expect(executeImageSearch(host, { query })).resolves.toEqual({
        error: "Image search failed.",
      });
      const event = sink.events.find((entry) => entry.message === "image_search.failed");
      expect(event).toMatchObject({
        level: "warn",
        "run.id": host.request.runId,
        "model.id": host.activeModel.model.id,
      });
      expect(event?.error?.message).toContain("quota exhausted");
      const serialized = JSON.stringify(event);
      for (const value of [query, secret, token]) expect(serialized).not.toContain(value);
    },
  );

  it.each([
    { reason: "max_output_tokens", completed: true },
    { reason: "max_output_tokens", completed: false },
    { reason: "content_filter", completed: true },
    { reason: "content_filter", completed: false },
  ])(
    "handles incomplete responses with $reason and completed search $completed",
    async ({ reason, completed }) => {
      const fetch = fixtureFetch([
        ...(completed ? [searchItem([image("completed")])] : []),
        ...prose,
        {
          type: "response.incomplete",
          response: { ...terminal.response, status: "incomplete", incomplete_details: { reason } },
        },
      ]);
      const { host, onUsage } = hostFor(fetch);
      const result = await executeImageSearch(host, { query: "harbor" });
      if (reason === "max_output_tokens" && completed) {
        expect(result).toMatchObject({
          results: [
            {
              imageUrl: image("completed").image_url,
              sourceUrl: image("completed").source_website_url,
            },
          ],
        });
      } else expect(result).toHaveProperty("error");
      expect(onUsage).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain("Invented prose");
    },
  );

  it.each(["a", "error", "png", "401"])(
    "retains structured failure diagnostics when query %s is redacted",
    async (query) => {
      const sink = createTestSink();
      installLogger(createLogger({ service: "test", sinks: [sink] }));
      const { host, observer } = hostFor(fixtureFetch([terminal]));
      observer.beforeCall.mockRejectedValue(
        new Error(`401: authentication token expired query="${query}"`),
      );
      await expect(executeImageSearch(host, { query })).resolves.toEqual({
        error: "Image search failed.",
      });
      const event = sink.events.find((entry) => entry.message === "image_search.failed");
      expect(event).toMatchObject({ "provider.status": 401, "failure.kind": "auth" });
      expect(event?.error?.message).toContain('query="[redacted]"');
    },
  );

  it("uses the active credential store and returns only completed structured images with retrieval accounting", async () => {
    vi.stubEnv("OPENAI_API_KEY", "unrelated-fake-key");
    const fetch = fixtureFetch([
      searchItem([image("partial")], "partial", "in_progress"),
      searchItem([image("first")]),
      searchItem([image("replacement")]),
      searchItem([image("replacement"), image("second")], "search-2"),
      ...prose,
      terminal,
    ]);
    const { host, events, observer, executeTool, onUsage } = hostFor(fetch);
    const rotatedToken = fakeToken("rotated-signature");
    await host.activeModel.credentials?.modify("openai-codex", async (current) =>
      current?.type === "oauth" ? { ...current, access: rotatedToken } : current,
    );
    const tool = toAgentTools(builtinAgentTools, host).find(
      (entry) => entry.name === "image_search",
    );
    if (!tool) throw new Error("image_search was deferred or omitted");
    const result = await tool.execute("search-call", { query: "harbor photos", maxResults: 2 });
    expect(result.details).toEqual({
      results: ["replacement", "second"].map((name) => ({
        imageUrl: image(name).image_url,
        sourceUrl: image(name).source_website_url,
        title: image(name).caption,
        thumbnailUrl: image(name).thumbnail_url,
      })),
    });
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining(image("replacement").image_url) },
    ]);
    expect(JSON.stringify(result)).not.toContain("Invented prose");
    expect(executeTool).not.toHaveBeenCalled();
    expect(host.request.gateImageSearch).toHaveBeenCalledWith(
      { query: "harbor photos", maxResults: 2 },
      expect.any(String),
      expect.any(Function),
    );
    expect(fetch).toHaveBeenCalledOnce();
    const call = fetch.mock.calls[0];
    if (!call) throw new Error("Missing request");
    const request = new Request(...call);
    expect(request.headers.get("authorization")).toBe(`Bearer ${rotatedToken}`);
    expect(request.headers.get("chatgpt-account-id")).toBe(accountId);
    expect(request.headers.get("x-openai-internal-codex-residency")).toBe("eu");
    const body = await requestBody(call);
    expect(body).toMatchObject({
      model: host.activeModel.model.id,
      store: false,
      tools: [
        {
          type: "web_search",
          search_content_types: ["image"],
          image_settings: { max_results: 2, caption: true },
        },
      ],
      tool_choice: { type: "web_search" },
    });
    expect(body.include).toEqual(["reasoning.encrypted_content", "web_search_call.results"]);
    expect(body.tools).toHaveLength(1);
    expect(body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [{ type: "input_text", text: "harbor photos" }],
        }),
      ]),
    );
    expect(body).not.toHaveProperty("prompt_cache_key");
    expect(observer.beforeCall).toHaveBeenCalledWith(
      expect.objectContaining({ operationKind: "retrieval", runId: "run-test" }),
    );
    expect(observer.afterCall).toHaveBeenCalledWith(
      "reservation-test",
      expect.objectContaining({ inputTokens: 12, outputTokens: 3 }),
    );
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "usage", operationKind: "retrieval" }),
    );
    expect(events.filter((event) => event.type === "usage")).toEqual([
      expect.objectContaining({ operationKind: "retrieval", accounted: true }),
    ]);
    expect(events.some((event) => event.type === "text")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("Invented prose");
    expect(describeToolActivity("image_search", { query: "harbor photos" })).toBe(
      "Searching images: harbor photos",
    );
  });

  it("ignores malformed and non-public result links and bounds optional strings", async () => {
    const badUrls = [
      "file:///tmp/photo.jpg",
      "data:image/png;base64,abcd",
      "https://localhost/a",
      "http://127.0.0.1/a",
      "http://[::1]/a",
      "http://169.254.169.254/a",
      "http://10.0.0.1/a",
      "https://user:pass@example.com/a",
      `https://example.com/${"a".repeat(4096)}`,
    ];
    const fetch = fixtureFetch([
      searchItem([
        null,
        7,
        { type: "image_result" },
        { ...image("wrong-type"), type: "text_result" },
        ...badUrls.map((url) => ({ ...image("bad-image"), image_url: url })),
        ...badUrls.map((url) => ({ ...image("bad-source"), source_website_url: url })),
        { ...image("safe"), caption: "x".repeat(1000), thumbnail_url: "http://192.168.1.1/a" },
        { ...image("other"), caption: { bad: true }, thumbnail_url: 42 },
      ]),
      terminal,
    ]);
    const { host } = hostFor(fetch);
    await expect(executeImageSearch(host, { query: "photos" })).resolves.toEqual({
      results: [
        {
          imageUrl: image("safe").image_url,
          sourceUrl: image("safe").source_website_url,
          title: "x".repeat(500),
        },
        { imageUrl: image("other").image_url, sourceUrl: image("other").source_website_url },
      ],
    });
  });

  it.each([0, 1, 10, 50])("bounds the requested and returned count for %s", async (requested) => {
    const fetch = fixtureFetch([
      searchItem(Array.from({ length: 20 }, (_, i) => image(String(i)))),
      terminal,
    ]);
    const { host } = hostFor(fetch);
    const result = await executeImageSearch(host, { query: "photos", maxResults: requested });
    expect("results" in result && result.results.length).toBe(Math.max(1, Math.min(10, requested)));
    const call = fetch.mock.calls[0];
    if (!call) throw new Error("Missing request");
    expect((await requestBody(call)).tools[0].image_settings.max_results).toBe(
      Math.max(1, Math.min(10, requested)),
    );
  });

  it("returns successful zero results for a completed empty search", async () => {
    const { host } = hostFor(fixtureFetch([searchItem([]), ...prose, terminal]));
    await expect(executeImageSearch(host, { query: "photos" })).resolves.toEqual({ results: [] });
  });

  it.each([
    [...prose, terminal],
    [searchItem([image("partial")], "partial", "in_progress"), terminal],
  ])("rejects a reply without a completed search", async (...events) => {
    const { host } = hostFor(fixtureFetch(events));
    await expect(executeImageSearch(host, { query: "photos" })).resolves.toEqual({
      error: "Image search returned no completed search.",
    });
  });

  it.each([
    [searchItem([image("partial")])],
    [
      searchItem([image("partial")]),
      { type: "response.failed", response: { error: { message: "Provider prose must not leak" } } },
    ],
  ])("discards completed items if the enclosing stream fails", async (...events) => {
    const { host, observer } = hostFor(fixtureFetch(events));
    await expect(executeImageSearch(host, { query: "photos" })).resolves.toEqual({
      error: "Image search failed.",
    });
    expect(observer.afterCall).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "handles raw-only progress through Pi and the usage wrapper, completes: %s",
    async (complete) => {
      vi.useFakeTimers();
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const fetch = vi.fn<typeof globalThis.fetch>(
        async (_input, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller;
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.error(init.signal?.reason),
                  { once: true },
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const { host } = hostFor(fetch);
      let settled = false;
      const result = executeImageSearch(host, { query: "photos" }).then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(0);
      body.enqueue(new TextEncoder().encode(sse([searchItem([image("first")])])));
      await vi.advanceTimersByTimeAsync(0);
      for (let index = 0; index < 3; index++) {
        await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS - 1);
        expect(settled).toBe(false);
        body.enqueue(
          new TextEncoder().encode(
            sse([{ type: "response.web_search_call.searching", item_id: "search-2" }]),
          ),
        );
        await vi.advanceTimersByTimeAsync(0);
      }
      if (complete) {
        body.enqueue(new TextEncoder().encode(sse([terminal])));
        body.close();
        await vi.advanceTimersByTimeAsync(0);
        await expect(result).resolves.toMatchObject({
          results: [{ imageUrl: image("first").image_url }],
        });
      } else {
        await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS);
        await expect(result).resolves.toEqual({ error: "Image search failed." });
      }
      expect(fetch).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("discards partial results on caller abort", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sse([searchItem([image("partial")])])));
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
                once: true,
              });
              started();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const { host, controller } = hostFor(fetch);
    const result = executeImageSearch(host, { query: "photos" });
    await ready;
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(result).resolves.toEqual({ error: "Image search was stopped." });
  });

  it("does not make a request for invalid queries or an already stopped run", async () => {
    const fetch = fixtureFetch([terminal]);
    const { host, controller } = hostFor(fetch);
    for (const query of [undefined, " ", "a".repeat(2001)])
      expect(await executeImageSearch(host, { query })).toHaveProperty("error");
    controller.abort();
    expect(await executeImageSearch(host, { query: "photos" })).toEqual({
      error: "Image search was stopped.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns an explicit error after the active target switches to an unsupported provider", async () => {
    const fetch = fixtureFetch([terminal]);
    const { host, executeTool } = hostFor(fetch);
    host.activeModel = {
      ...host.activeModel,
      model: { ...host.activeModel.model, provider: "other" },
    };
    const tool = toAgentTools(builtinAgentTools, host).find(
      (entry) => entry.name === "image_search",
    );
    if (!tool) throw new Error("image_search missing");
    await expect(tool.execute("search", { query: "photos" })).resolves.toMatchObject({
      details: { error: "Image search is unavailable for this model." },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
    expect(host.request.gateImageSearch).not.toHaveBeenCalled();
  });
});

it("offers image search only for a supported model and lets bots disable it independently", () => {
  const base = {
    graphicalToolsAllowed: false,
    groupId: null,
    trigger: "user",
    semanticMemoryEnabled: false,
    messagingChannelRun: false,
  };
  const names = (provider: string, disabledBuiltinTools?: string[]) =>
    selectBuiltinToolsForRun({
      ...base,
      modelImageSearchEnabled: supportsModelImageSearch(provider),
      disabledBuiltinTools,
    }).map((tool) => tool.name);
  expect(names("openai-codex")).toContain("image_search");
  for (const provider of ["openai", "openrouter", "other"])
    expect(names(provider)).not.toContain("image_search");
  expect(names("openai-codex", ["image_search"])).not.toContain("image_search");
  expect(names("openai-codex", ["image_search"])).toContain("web_search");
  expect(names("openai-codex", ["web_search", "generate_image"])).toContain("image_search");
  expect(READ_ONLY_AGENT_TOOLS.has("image_search")).toBe(true);
  expect(builtinAgentTools.find((tool) => tool.name === "image_search")?.readOnly).toBe(true);
});

it("refuses runtime image search without its gate even when executeTool exists", async () => {
  const fetch = fixtureFetch([terminal]);
  const { host, executeTool } = hostFor(fetch);
  host.request.gateImageSearch = undefined;
  const tool = toAgentTools(builtinAgentTools, host).find((tool) => tool.name === "image_search")!;
  await expect(tool.execute("missing-gate", { query: "harbor" })).resolves.toMatchObject({
    content: [{ type: "text", text: "image_search is unavailable without an executor." }],
    details: { error: "no executor" },
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(executeTool).not.toHaveBeenCalled();
});

it.each([true, false])(
  "filters background image search by capability and disabled tools: %s",
  (enabled) => {
    const options = {
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "helper",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
      modelImageSearchEnabled: enabled,
    };
    expect(selectBuiltinToolsForRun(options).some((tool) => tool.name === "image_search")).toBe(
      enabled,
    );
    expect(
      selectBuiltinToolsForRun({ ...options, disabledBuiltinTools: ["image_search"] }).some(
        (tool) => tool.name === "image_search",
      ),
    ).toBe(false);
  },
);
