import { createServer } from "node:http";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeAgentToolName, normalizeAgentToolNames, PiAgentRuntime } from "./pi-runtime.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object" } };
}

describe("Pi agent runtime", () => {
  it("reports an unknown model without calling a provider", async () => {
    const runtime = new PiAgentRuntime();
    const events: string[] = [];
    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "hi",
        instructions: "test",
        history: [],
        tools: [],
        model: { provider: "openrouter", id: "not-a-real-model-xyz" },
      },
      {
        operationId: "1",
        traceId: "1",
        workspaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      if (event.type === "text") events.push(event.text);
      if (event.type === "error") events.push(event.message);
    }
    expect(events.join(" ")).toMatch(/Unknown model/i);
  });

  it("streams reasoning and text from a keyless local fake gateway without leaking the deployment key", async () => {
    const requests: Array<{ authorization?: string; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push({
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            id: "fake-chunk-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "fake-model",
            choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "checking" } }],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "fake-chunk-2",
            object: "chat.completion.chunk",
            created: 1,
            model: "fake-model",
            choices: [{ index: 0, delta: { content: "hello from fake gateway" } }],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "fake-chunk-3",
            object: "chat.completion.chunk",
            created: 1,
            model: "fake-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      });
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const oldDeploymentKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "fake-openrouter-deployment-key";
    try {
      const runtime = new PiAgentRuntime();
      const events = [];
      for await (const event of runtime.run(
        {
          botId: "b",
          threadId: "t",
          runId: "fake-gateway-run",
          prompt: "say hello",
          instructions: "test",
          history: [],
          tools: [],
          model: {
            provider: "gateway:fake",
            id: "fake-model",
            baseUrl: `${baseUrl}/v1`,
            allowPrivateNetwork: true,
          },
        },
        {
          operationId: "1",
          traceId: "1",
          workspaceId: "w",
          userId: "u",
          signal: new AbortController().signal,
        },
      )) {
        events.push(event);
      }

      expect(requests).toHaveLength(1);
      expect(requests[0]?.authorization).toBeUndefined();
      expect(requests[0]?.authorization ?? "").not.toContain("fake-openrouter-deployment-key");
      expect(JSON.parse(requests[0]!.body)).toMatchObject({ model: "fake-model" });
      expect(
        events
          .filter((event) => event.type === "text")
          .map((event) => event.text)
          .join(""),
      ).toContain("hello from fake gateway");
      const finalReasoning = events.findIndex(
        (event) =>
          event.type === "reasoning" &&
          event.step.id === "status:done" &&
          event.step.status === "done",
      );
      const thought = events.findIndex(
        (event) =>
          event.type === "reasoning" && event.step.kind === "think" && event.step.status === "done",
      );
      const done = events.findIndex((event) => event.type === "done");
      expect(
        events.some((event) => event.type === "reasoning" && event.step.kind === "think"),
      ).toBe(true);
      expect(finalReasoning).toBeGreaterThanOrEqual(0);
      expect(finalReasoning).toBeGreaterThan(thought);
      expect(done).toBeGreaterThan(finalReasoning);
    } finally {
      if (oldDeploymentKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = oldDeploymentKey;
    }
  });
});

describe("Pi model-facing connector tool names", () => {
  it("leaves builtin-compatible names unchanged", () => {
    expect(normalizeAgentToolName("write_file")).toBe("write_file");
    expect(normalizeAgentToolNames([tool("write_file"), tool("shell")])).toEqual([
      "write_file",
      "shell",
    ]);
  });

  it("normalizes punctuation, whitespace, and Unicode to the provider-safe pattern", () => {
    const names = normalizeAgentToolNames([
      tool("destination.write"),
      tool("Google Calendar / criar evento"),
      tool("🦊"),
    ]);

    expect(names[0]).toBe("destination_write");
    expect(names[1]).toBe("Google_Calendar_criar_evento");
    expect(names[2]).toBe("connector_tool");
    expect(names.every((name) => /^[a-zA-Z0-9_-]+$/.test(name))).toBe(true);
  });

  it("limits long names to the provider's 64-character maximum", () => {
    const name = normalizeAgentToolName(`very-long-${"x".repeat(100)}`);

    expect(name).toHaveLength(64);
    expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("keeps normalized names unique and deterministic without shadowing valid names", () => {
    const tools = [tool("foo.bar"), tool("foo bar"), tool("foo_bar"), tool("🦊"), tool("🦊")];

    const first = normalizeAgentToolNames(tools);
    const second = normalizeAgentToolNames(tools);

    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(tools.length);
    expect(first[2]).toBe("foo_bar");
    expect(first.every((name) => /^[a-zA-Z0-9_-]+$/.test(name))).toBe(true);
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing test port"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
