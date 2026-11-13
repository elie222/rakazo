import type { ConnectorEvent } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { connectorTool } from "./run-tools-integrations.js";

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

  it("keeps secrets held in the run out of the result the model reads back", async () => {
    const code = "482913";
    const { ctx, call } = setup(
      [{ type: "result", data: { content: [{ type: "text", text: `Your code is ${code}` }] } }],
      {},
      [code],
    );

    const returned = await connectorTool(ctx, call);

    expect(JSON.stringify(returned)).not.toContain(code);
    expect(JSON.stringify(returned)).toContain("Your code is");
  });

  it("keeps a held code out of a message returned base64-encoded", async () => {
    const code = "482913";
    const raw = Buffer.from(`Subject: Sign in\r\n\r\nYour code is ${code}`).toString("base64url");
    const { ctx, call } = setup(
      [{ type: "result", data: { raw, payload: { body: { data: raw } }, id: "msg-1" } }],
      {},
      [code],
    );

    const returned = await connectorTool(ctx, call);

    expect(JSON.stringify(returned)).not.toContain(raw);
    expect(returned).toMatchObject({ id: "msg-1" });
  });

  it.each([0, 1, 2])(
    "keeps a held code out of base64 text however it is aligned (%i bytes in)",
    async (lead) => {
      const code = "482913";
      const message = `${"x".repeat(lead + 3)}Your code is ${code}, do not share it`;
      const { ctx, call } = setup(
        [
          {
            type: "result",
            data: {
              url: Buffer.from(message).toString("base64url"),
              std: Buffer.from(`${message}??>>`).toString("base64"),
              wrapped: Buffer.from(message)
                .toString("base64")
                .replace(/(.{20})/g, "$1\r\n"),
              mcp: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ raw: Buffer.from(message).toString("base64url") }),
                  },
                ],
              },
            },
          },
        ],
        {},
        [code],
      );

      const shown = JSON.stringify(await connectorTool(ctx, call));

      for (const part of ["url", "std", "wrapped", "mcp"]) expect(shown).toContain(part);
      expect(shown).not.toMatch(/WW91ciBjb2Rl|eW91ciBjb2Rl|b3VyIGNvZGU|NDgyOTEz|Q4MjkxM|ODI5MT/);
      expect(shown).toContain("[redacted]");
    },
  );

  it("keeps a held code out of a message whose body is base64 inside base64", async () => {
    const code = "482913";
    const body = Buffer.from(`Your code is ${code}`).toString("base64");
    const raw = Buffer.from(`Content-Transfer-Encoding: base64\r\n\r\n${body}`).toString(
      "base64url",
    );
    const { ctx, call } = setup([{ type: "result", data: { raw } }], {}, [code]);

    expect(JSON.stringify(await connectorTool(ctx, call))).not.toContain(raw);
  });

  it("withholds a string that holds the code in plain text and in base64", async () => {
    const code = "482913";
    const data = Buffer.from(`Subject: Sign in\r\n\r\nYour code is ${code}`).toString("base64url");
    const text = JSON.stringify({ snippet: `Your code is ${code}`, payload: { body: { data } } });
    const { ctx, call } = setup(
      [{ type: "result", data: { content: [{ type: "text", text }] } }],
      {},
      [code],
    );

    const shown = JSON.stringify(await connectorTool(ctx, call));

    expect(shown).not.toContain(code);
    expect(shown).not.toContain(data);
  });

  it.each([0, 1, 2, 3, 4, 5])(
    "catches base64 wrapped over lines inside a JSON text block (%i characters in)",
    async (lead) => {
      const code = "482913";
      const message = `${"x".repeat(lead)}Your code is ${code} and more text after it`;
      const wrapped = Buffer.from(message)
        .toString("base64")
        .replace(/(.{7})/g, "$1\r\n");
      const text = JSON.stringify({ raw: wrapped });
      const { ctx, call } = setup(
        [{ type: "result", data: { content: [{ type: "text", text }] } }],
        {},
        [code],
      );

      expect(JSON.stringify(await connectorTool(ctx, call))).not.toContain(wrapped.slice(0, 7));
    },
  );

  it("catches a base64 message inside base64 held in a JSON text block", async () => {
    const code = "482913";
    const inner = Buffer.from(`Your code is ${code}`).toString("base64");
    const raw = Buffer.from(`Content-Transfer-Encoding: base64\r\n\r\n${inner}`).toString(
      "base64url",
    );
    const text = JSON.stringify({ id: "msg-1", raw });
    const { ctx, call } = setup(
      [{ type: "result", data: { content: [{ type: "text", text }] } }],
      {},
      [code],
    );

    expect(JSON.stringify(await connectorTool(ctx, call))).not.toContain(raw);
  });

  it.each([
    "raw ",
    "Attachment ",
    "id_",
    "https://x/raw/",
    "Content-Transfer-Encoding: base64\r\n\r\n",
  ])("catches a base64 message inside base64 after other text (%j)", async (prefix) => {
    const code = "482913";
    const inner = Buffer.from(`Your code is ${code}`).toString("base64");
    const outer = Buffer.from(`Content-Transfer-Encoding: base64\r\n\r\n${inner}`).toString(
      "base64url",
    );
    const { ctx, call } = setup(
      [{ type: "result", data: { content: [{ type: "text", text: `${prefix}${outer}` }] } }],
      {},
      [code],
    );

    expect(JSON.stringify(await connectorTool(ctx, call))).not.toContain(outer);
  });

  it.each([0, 1, 2, 3, 4, 5, 6])(
    "catches wrapped base64 in JSON that was stringified twice (%i characters in)",
    async (lead) => {
      const code = "482913";
      const message = `${"x".repeat(lead)}Your code is ${code} and more text after it`;
      const wrapped = Buffer.from(message)
        .toString("base64")
        .replace(/(.{7})/g, "$1\r\n");
      const text = JSON.stringify(JSON.stringify({ raw: wrapped }));
      const { ctx, call } = setup(
        [{ type: "result", data: { content: [{ type: "text", text }] } }],
        {},
        [code],
      );

      expect(JSON.stringify(await connectorTool(ctx, call))).not.toContain(wrapped.slice(0, 7));
    },
  );

  it("keeps a large result while the run holds a secret", async () => {
    const big = "A".repeat(12_000_000);
    const { ctx, call } = setup([{ type: "result", data: { big, id: "msg-1" } }], {}, ["482913"]);

    expect(await connectorTool(ctx, call)).toEqual({ big, id: "msg-1" });
  });

  it("returns a result untouched when the run holds no secrets, however large", async () => {
    const big = "A".repeat(12_000_000);
    const { ctx, call } = setup([{ type: "result", data: { big } }]);

    expect(await connectorTool(ctx, call)).toEqual({ big });
  });

  it("leaves encoded text that holds no secret as it was", async () => {
    const raw = Buffer.from("Subject: Hello\r\n\r\nSee you at noon").toString("base64url");
    const { ctx, call } = setup([{ type: "result", data: { raw } }], {}, ["482913"]);

    expect(await connectorTool(ctx, call)).toEqual({ raw });
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

describe("connector tool results in a run that holds a secret", () => {
  it("returns what the call did: the call already ran", async () => {
    const data = { data: { sent: true, id: "m9" } };
    const { ctx, call } = setup([{ type: "result", data }], {}, ["482913"]);
    expect(await connectorTool(ctx, call)).toEqual(data);
  });
});
