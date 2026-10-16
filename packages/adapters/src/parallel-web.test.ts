import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { ParallelWebProvider } from "./parallel-web.js";
import { parallelMcpFixture } from "./parallel-web.test-support.js";
import { createWebProvider, resolveWebProviderKind } from "./web-provider-factory.js";
import { webFetchFromTool, webSearchFromTool } from "./web-tools.js";

const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};

describe("optional Parallel web provider", () => {
  it.each([false, true])(
    "maps MCP results through the selected web tool (text-only=%s)",
    async (textOnly) => {
      const peer = parallelMcpFixture({ textOnly });
      const provider = createWebProvider(
        resolveWebProviderKind({ WEB_PROVIDER: "parallel" }),
        peer.network,
      );
      expect(
        await webSearchFromTool(provider, context, { query: "current question", maxResults: 1 }),
      ).toEqual({
        results: [
          { title: "Source", url: "https://example.test/page", snippet: "Useful evidence" },
        ],
      });
      expect(peer.calls[0]).toMatchObject({
        name: "web_search",
        arguments: { objective: "current question", search_queries: ["current question"] },
      });
      expect(peer.requests.length).toBeGreaterThan(1);
      for (const request of peer.requests) {
        expect(request.url).toBe("https://search.parallel.ai/mcp");
        expect(request.headers.get("user-agent")).toBe(
          "Rakazo/0.1 (+https://github.com/elie222/rakazo; web tools)",
        );
        expect(request.headers.has("authorization")).toBe(false);
      }
      expect(resolveWebProviderKind({})).toBe("keyless-http");
      for (const kind of ["", "keyless", "keyless-http"])
        expect(createWebProvider(kind).describe().id).toBe("keyless-http");
      expect(createWebProvider("fake").describe().id).toBe("fake");
      expect(() => createWebProvider("invalid")).toThrow("Unknown web provider");
    },
  );

  it("maps page markdown, caps content and keeps conversation accounting stable", async () => {
    const peer = parallelMcpFixture();
    const provider = new ParallelWebProvider(peer.network);
    await provider.search({ query: "question" }, context);
    const page = await webFetchFromTool(provider, context, {
      url: "https://example.test/page",
      maxChars: 100,
    });
    expect(page).toEqual({
      title: "Source",
      url: "https://example.test/page",
      text: `${"Page text ".repeat(10)}\n\n[Content truncated]`,
      truncated: true,
    });
    expect(peer.calls[1]).toMatchObject({
      name: "web_fetch",
      arguments: { urls: ["https://example.test/page"], full_content: true },
    });
    expect(peer.calls[0]!.arguments.session_id).toMatch(/^[a-f0-9]{64}$/);
    expect(peer.calls[1]!.arguments.session_id).toBe(peer.calls[0]!.arguments.session_id);
    await provider.search({ query: "question" }, { ...context, userId: "other-user" });
    expect(peer.calls[2]!.arguments.session_id).not.toBe(peer.calls[0]!.arguments.session_id);
  });

  it.each([
    "http://localhost/private",
    "https://169.254.169.254/",
    "https://name:password@example.test/",
  ])("rejects unsafe page URL %s before any MCP request", async (url) => {
    const peer = parallelMcpFixture();
    await expect(new ParallelWebProvider(peer.network).fetch({ url }, context)).rejects.toThrow();
    expect(peer.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      { isError: true, content: [{ type: "text", text: "Rate limit exceeded" }] },
      "Rate limit exceeded",
    ],
    [{ content: [{ type: "text", text: "broken JSON" }] }, "Invalid Parallel MCP response"],
    [
      {
        structuredContent: { results: [{ url: "https://example.test", excerpts: null }] },
        content: [],
      },
      "Invalid Parallel MCP response",
    ],
  ])("surfaces tool and malformed response errors without fallback", async (result, message) => {
    const peer = parallelMcpFixture({ result });
    const response = await webSearchFromTool(new ParallelWebProvider(peer.network), context, {
      query: "q",
    });
    expect(response).toEqual({ error: expect.stringContaining(message as string) });
    expect(peer.calls).toHaveLength(1);
    expect(peer.requests.every((request) => request.url === "https://search.parallel.ai/mcp")).toBe(
      true,
    );
  });

  it("surfaces failed page extraction", async () => {
    const peer = parallelMcpFixture({
      result: {
        content: [],
        structuredContent: { results: [], errors: [{ error_type: "FETCH_FAILED" }] },
      },
    });
    await expect(
      new ParallelWebProvider(peer.network).fetch({ url: "https://example.test/page" }, context),
    ).rejects.toThrow("FETCH_FAILED");
  });

  it.each(["request", "context"])(
    "makes no requests when the %s is already cancelled",
    async (source) => {
      const peer = parallelMcpFixture();
      const controller = new AbortController();
      controller.abort(new Error("Stopped"));
      await expect(
        new ParallelWebProvider(peer.network).search(
          {
            query: "q",
            signal: source === "request" ? controller.signal : new AbortController().signal,
          },
          source === "context" ? { ...context, signal: controller.signal } : context,
        ),
      ).rejects.toThrow("Stopped");
      expect(peer.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["cancel", "timeout"])("interrupts an active MCP call on %s", async (mode) => {
    let started!: () => void;
    const opened = new Promise<void>((resolve) => {
      started = resolve;
    });
    const peer = parallelMcpFixture({
      call: async (request) =>
        new Promise<Response>((_resolve, reject) => {
          started();
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });
    const controller = new AbortController();
    const provider = new ParallelWebProvider({
      ...peer.network,
      searchTimeoutMs: mode === "timeout" ? 30 : 5000,
    });
    const result = provider
      .search({ query: "q", signal: controller.signal }, context)
      .catch((error: unknown) => error);
    await opened;
    if (mode === "cancel") controller.abort(new Error("Stopped"));
    expect(await result).toBeInstanceOf(Error);
    expect(peer.requests.findLast((request) => request.method === "POST")!.signal.aborted).toBe(
      true,
    );
  });
});
