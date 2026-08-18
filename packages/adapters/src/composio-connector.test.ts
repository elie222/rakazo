import { describe, expect, it, vi } from "vitest";
import {
  asConnectorTools,
  ComposioConnector,
  collectLogIds,
  collectPages,
  executeSessionKey,
  filterCatalog,
  isComposioEnabled,
  isNoAuthToolkitError,
  sanitizeComposioError,
} from "./composio-connector.js";

describe("composio tool mapping", () => {
  it("maps OpenAI-style session tools and raw slugs", () => {
    const tools = asConnectorTools([
      {
        type: "function",
        function: {
          name: "COMPOSIO_SEARCH_TOOLS",
          description: "Search tools",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      },
      {
        slug: "HACKERNEWS_GET_USER",
        description: "Look up a public HN profile",
        inputParameters: { type: "object", properties: { username: { type: "string" } } },
      },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "COMPOSIO_SEARCH_TOOLS",
      "HACKERNEWS_GET_USER",
    ]);
    expect(tools[1]?.inputSchema).toMatchObject({ properties: { username: { type: "string" } } });
  });

  it("redacts project keys from errors", () => {
    expect(sanitizeComposioError("denied ak_secretvaluehere")).toContain("[redacted]");
    expect(sanitizeComposioError("denied ak_secretvaluehere")).not.toContain("ak_secret");
    expect(sanitizeComposioError("COMPOSIO_API_KEY=ak_shouldnotleak")).not.toContain(
      "ak_shouldnotleak",
    );
  });

  it("paginates until the cursor ends", async () => {
    const pages = [
      { items: ["gmail", "github"], cursor: "page-2" },
      { items: ["slack"], cursor: undefined },
    ];
    const items = await collectPages(async (cursor) => {
      if (!cursor) return pages[0]!;
      return pages[1]!;
    });
    expect(items).toEqual(["gmail", "github", "slack"]);
  });

  it("treats Composio no-auth toolkit errors as in-app connect", () => {
    expect(
      isNoAuthToolkitError(
        new Error(
          '400 {"error":{"message":"Toolkit hackernews does not require authentication.","slug":"ToolRouterV2_ToolkitsIsNoAuth"}}',
        ),
      ),
    ).toBe(true);
    expect(isNoAuthToolkitError(new Error("redirect required"))).toBe(false);
  });

  it("collects nested Composio log ids", () => {
    expect(
      collectLogIds({
        logId: "",
        data: { results: [{ log_id: "log_abc123", slug: "HACKERNEWS_GET_USER" }] },
      }),
    ).toEqual(["log_abc123"]);
  });

  it("keys execute sessions by sorted unique toolkits", () => {
    expect(executeSessionKey(["hackernews", "gmail", "hackernews"])).toBe("gmail,hackernews");
    expect(executeSessionKey([])).toBe("");
  });

  it("filters the catalog by name or slug", () => {
    const items = [
      { slug: "github", name: "GitHub", logo: null, connected: false, noAuth: false },
      { slug: "hackernews", name: "Hacker News", logo: null, connected: false, noAuth: true },
    ];
    expect(filterCatalog(items, "hacker").map((item) => item.slug)).toEqual(["hackernews"]);
  });
});

describe("Composio during pnpm test", () => {
  it("does not construct a live Platform client under Vitest", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(isComposioEnabled("ck_must_not_call_live")).toBe(false);
  });

  it("forwards execution cancellation to the Composio session", async () => {
    const execute = vi.fn(
      async (
        _tool: string,
        _args: Record<string, unknown>,
        _options: undefined,
        requestOptions: { signal?: AbortSignal },
      ) =>
        new Promise((_, reject) => {
          const signal = requestOptions.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const create = vi.fn(
      async (_userId: string, _config: unknown, _requestOptions: { signal?: AbortSignal }) => ({
        sessionId: "session-1",
        execute,
      }),
    );
    const connector = new ComposioConnector(
      () => ({ create, sessions: { use: vi.fn() } }) as never,
    );
    const controller = new AbortController();
    const events = connector.execute(
      { tool: "GOOGLETASKS_LIST_TASKS", args: {}, executionId: "test-execution" },
      {
        operationId: "test",
        traceId: "test",
        workspaceId: "workspace-1",
        userId: "user-1",
        connectedProviders: ["GOOGLETASKS"],
        signal: controller.signal,
      },
    );
    const next = events[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    controller.abort(new Error("cancelled"));

    await expect(next).resolves.toEqual({
      done: false,
      value: { type: "error", message: "cancelled" },
    });
    expect(create.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
    expect(execute.mock.calls[0]?.[3]?.signal).toBe(controller.signal);
  });

  it("forwards revocation cancellation through lookup and deletion", async () => {
    const toolkits = vi.fn(async (_query: unknown, requestOptions: { signal?: AbortSignal }) => ({
      items: [
        {
          slug: "GOOGLETASKS",
          connection: { connectedAccount: { id: "account-1" } },
        },
      ],
      signal: requestOptions.signal,
    }));
    const create = vi.fn(
      async (_userId: string, _config: unknown, _requestOptions: { signal?: AbortSignal }) => ({
        sessionId: "session-1",
        toolkits,
      }),
    );
    const remove = vi.fn(
      async (_accountId: string, requestOptions: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          const signal = requestOptions.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const connector = new ComposioConnector(
      () =>
        ({
          create,
          sessions: { use: vi.fn() },
          connectedAccounts: { delete: remove },
        }) as never,
    );
    const controller = new AbortController();
    const revocation = connector.revoke("GOOGLETASKS", {
      operationId: "test",
      traceId: "test",
      workspaceId: "workspace-1",
      userId: "user-1",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());

    controller.abort(new Error("cancelled"));

    await expect(revocation).rejects.toThrow("cancelled");
    expect(create.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
    expect(toolkits.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(remove.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
