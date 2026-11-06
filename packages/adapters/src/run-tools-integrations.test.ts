import type { ConnectorEvent } from "@rakazo/adapter-kit";
import { createStreamingRedactor } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeToolFileStore } from "./fake-tool-files.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { connectorTool } from "./run-tools-integrations.js";
import { LOCAL_FILE_PATH_UNSUPPORTED } from "./tool-file-args.js";

const executed: Array<{ withApp?: boolean }> = [];
const publishMessage = vi.fn(async (..._args: unknown[]) => null);
const storeMcpAppHtml = vi.fn(async (..._args: unknown[]) => "artifact-app");

vi.mock("./run-messages.js", () => ({
  publishMessage: (...args: unknown[]) => publishMessage(...args),
}));
vi.mock("./thread-artifacts.js", () => ({
  storeMcpAppHtml: (...args: unknown[]) => storeMcpAppHtml(...args),
}));

function setup(events: ConnectorEvent[], artifacts: unknown = {}, secrets: string[] = []) {
  const ctx = {
    deps: {
      prisma: {},
      artifacts,
      events: { append: vi.fn() },
      connector: {
        async *execute(call: { withApp?: boolean }) {
          executed.push(call);
          yield* events;
        },
      },
    },
    run: { id: "run-1", spaceId: "space-1", userId: "user-1", trigger: "user" },
    bot: { id: "bot-1" },
    thread: { id: "thread-1", groupId: null },
    context: {},
    secrets,
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

  it("keeps secrets revealed in the run out of the card", async () => {
    const secret = "sk-live-revealed-value";
    const { ctx, call } = setup(
      [
        { type: "result", data: { content: [{ type: "text", text: `token ${secret}` }] } },
        { type: "app", app: { ...app, html: `<p>${secret}</p>` } },
      ],
      {},
      [secret],
    );
    (call as { args: Record<string, unknown> }).args = { city: "Lisbon", key: secret };

    await connectorTool(ctx, call);

    const blocks = publishMessage.mock.calls[0]?.[3];
    expect(JSON.stringify(blocks)).not.toContain(secret);
    expect(JSON.stringify(storeMcpAppHtml.mock.calls[0]?.[1])).not.toContain(secret);
    expect(JSON.stringify(blocks)).toContain("Lisbon");
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

  it("asks for the app only when the run posts cards", async () => {
    const chat = setup([{ type: "result", data: { content: [] } }]);
    await connectorTool(chat.ctx, chat.call);
    const background = setup([{ type: "result", data: { content: [] } }]);
    (background.ctx.run as { trigger: string }).trigger = "tickets";
    await connectorTool(background.ctx, background.call);
    expect(executed.slice(-2).map((call) => call.withApp)).toEqual([true, false]);
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

describe("connector tool with temporary files", () => {
  const SCOPE = { spaceId: "space-1", userId: "user-1", botId: "bot-1" };
  const PDF = new TextEncoder().encode("%PDF-1.7 expense receipt");
  const PDF_BASE64 = Buffer.from(PDF).toString("base64");

  async function filesSetup(
    respond: (args: Record<string, unknown>) => ConnectorEvent[],
    route: { connectorId: string; toolName: string } = {
      connectorId: "mcp",
      toolName: "upload_file",
    },
  ) {
    const store = new FakeToolFileStore();
    const file = await store.create({
      ...SCOPE,
      name: "receipt.pdf",
      mimeType: "application/pdf",
      bytes: PDF,
    });
    const sent: Array<Record<string, unknown>> = [];
    const finished: unknown[] = [];
    const ctx = {
      deps: {
        prisma: {},
        artifacts: null,
        toolFiles: store,
        events: { append: vi.fn() },
        connector: {
          async *execute(call: { args: Record<string, unknown> }) {
            sent.push(call.args);
            yield* respond(call.args);
          },
        },
      },
      run: { id: "run-1", spaceId: "space-1", userId: "user-1", trigger: "user" },
      bot: { id: "bot-1" },
      thread: { id: "thread-1", groupId: null },
      context: {},
      secrets: [] as string[],
      state: { reply: { pendingProgress: "", redactor: createStreamingRedactor([]) } },
    } as unknown as RunContext;
    const args = {
      // Green Invoice's expense upload_file: `data` is a JSON string.
      data: JSON.stringify({ filename: "receipt.pdf", file: `{{file:${file.id}}}` }),
      link: { url: `{{file_url:${file.id}}}` },
    };
    const call = {
      name: "mcp__invoices__upload_file",
      args,
      effectKey: "effect-1",
      connectorCall: { tool: "mcp__invoices__upload_file", args, executionId: "e1", route },
      finish: async (result: unknown) => {
        finished.push(result);
        return result;
      },
    } as unknown as ToolCall;
    return { store, file, sent, finished, ctx, call, args };
  }

  it("sends the content and a signed URL in place of the placeholders", async () => {
    const f = await filesSetup(() => [{ type: "result", data: { ok: true } }]);
    const original = structuredClone(f.args);
    expect(await connectorTool(f.ctx, f.call)).toEqual({ ok: true });
    expect(JSON.parse(f.sent[0]!.data as string)).toEqual({
      filename: "receipt.pdf",
      file: PDF_BASE64,
    });
    expect(f.sent[0]!.link).toEqual({ url: f.store.urls[0] });
    // The call's own arguments, which the effect and audit keep, still hold placeholders.
    expect(f.call.args).toEqual(original);
    expect(f.ctx.secrets).toEqual([f.store.urls[0]]);
  });

  it("never returns the content or URL the tool echoed", async () => {
    const f = await filesSetup((sent) => [
      {
        type: "result",
        data: {
          content: [{ type: "text", text: `stored ${sent.data} at ${JSON.stringify(sent.link)}` }],
        },
      },
    ]);
    const result = JSON.stringify(await connectorTool(f.ctx, f.call));
    expect(result).not.toContain(PDF_BASE64);
    expect(result).not.toContain(f.store.urls[0]!);
    expect(result).toContain(`{{file:${f.file.id}}}`);
    expect(result).toContain(`{{file_url:${f.file.id}}}`);
    expect(JSON.stringify(f.finished)).not.toContain(PDF_BASE64);
  });

  it("keeps the content out of a tool error", async () => {
    const f = await filesSetup((sent) => [
      { type: "error", message: `rejected ${String(sent.data)}` },
    ]);
    const result = JSON.stringify(await connectorTool(f.ctx, f.call));
    expect(result).not.toContain(PDF_BASE64);
    expect(result).toContain(`{{file:${f.file.id}}}`);
  });

  it("fails without calling the tool when a file expired", async () => {
    const f = await filesSetup(() => [{ type: "result", data: { ok: true } }]);
    f.store.expire(f.file.id);
    const result = (await connectorTool(f.ctx, f.call)) as { error: string };
    expect(result.error).toMatch(
      /^File \{\{file(_url)?:tf1\}\} is not available \(it may have expired\)$/,
    );
    expect(f.sent).toEqual([]);
  });

  it("leaves file paths to the MCP connector and refuses them for other connectors", async () => {
    const mcp = await filesSetup(() => [{ type: "result", data: { ok: true } }]);
    const pathArgs = { attachments: [`{{file_path:${mcp.file.id}}}`] };
    await connectorTool(mcp.ctx, { ...mcp.call, args: pathArgs } as ToolCall);
    expect(mcp.sent).toEqual([pathArgs]);

    const other = await filesSetup(() => [{ type: "result", data: { ok: true } }], {
      connectorId: "composio",
      toolName: "GMAIL_SEND_EMAIL",
    });
    expect(await connectorTool(other.ctx, { ...other.call, args: pathArgs } as ToolCall)).toEqual({
      error: LOCAL_FILE_PATH_UNSUPPORTED,
    });
    expect(other.sent).toEqual([]);
  });
});
