import type { ConnectorEvent } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { connectorTool } from "./run-tools-integrations.js";

const publishMessage = vi.fn(async (..._args: unknown[]) => null);
const storeMcpAppHtml = vi.fn(async (..._args: unknown[]) => "artifact-app");

vi.mock("./run-messages.js", () => ({
  publishMessage: (...args: unknown[]) => publishMessage(...args),
}));
vi.mock("./thread-artifacts.js", () => ({
  storeMcpAppHtml: (...args: unknown[]) => storeMcpAppHtml(...args),
}));

function setup(events: ConnectorEvent[], artifacts: unknown = {}) {
  const ctx = {
    deps: {
      prisma: {},
      artifacts,
      events: { append: vi.fn() },
      connector: {
        async *execute() {
          yield* events;
        },
      },
    },
    run: { id: "run-1", spaceId: "space-1", userId: "user-1" },
    bot: { id: "bot-1" },
    thread: { id: "thread-1", groupId: null },
    context: {},
  } as unknown as RunContext;
  const call = {
    name: "mcp__weather__get_forecast",
    args: { city: "Lisbon" },
    effectKey: "effect-1",
    connectorCall: {
      tool: "mcp__weather__get_forecast",
      args: { city: "Lisbon" },
      executionId: "e1",
      route: { connectorId: "mcp", toolName: "get_forecast" },
    },
    finish: async (result: unknown) => result,
  } as unknown as ToolCall;
  return { ctx, call };
}

const app = {
  server: "Weather",
  html: "<html>Forecast</html>",
  csp: { resourceDomains: ["https://cdn.weather.example"] },
};

describe("connector tool with an MCP app", () => {
  beforeEach(() => {
    publishMessage.mockClear();
    storeMcpAppHtml.mockClear();
  });

  it("posts the app as a card with the call's arguments and result", async () => {
    const result = { content: [{ type: "text", text: "Sunny" }], structuredContent: { high: 23 } };
    const { ctx, call } = setup([
      { type: "result", data: result },
      { type: "app", app },
    ]);

    expect(await connectorTool(ctx, call)).toEqual(result);

    expect(storeMcpAppHtml).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ botId: "bot-1", runId: "run-1", html: app.html }),
    );
    expect(publishMessage).toHaveBeenCalledWith(ctx.deps, ctx.run, "bot", [
      {
        kind: "app",
        artifactId: "artifact-app",
        server: "Weather",
        tool: "get_forecast",
        toolArguments: { city: "Lisbon" },
        toolResult: result,
        csp: app.csp,
      },
    ]);
  });

  it("returns the call's result when the card cannot be stored", async () => {
    storeMcpAppHtml.mockRejectedValueOnce(new Error("disk full"));
    const result = { content: [], structuredContent: { high: 23 } };
    const { ctx, call } = setup([
      { type: "result", data: result },
      { type: "app", app },
    ]);

    expect(await connectorTool(ctx, call)).toEqual(result);
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it("posts no card without artifact storage", async () => {
    const { ctx, call } = setup(
      [
        { type: "result", data: { content: [] } },
        { type: "app", app },
      ],
      null,
    );
    await connectorTool(ctx, call);
    expect(storeMcpAppHtml).not.toHaveBeenCalled();
  });
});
