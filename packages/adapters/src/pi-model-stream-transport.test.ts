import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import type * as Undici from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

const agentOptions = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("undici", async (importOriginal) => {
  const undici = await importOriginal<typeof Undici>();
  class RecordedAgent extends undici.Agent {
    constructor(options?: ConstructorParameters<typeof undici.Agent>[0]) {
      super(options);
      agentOptions.push({ ...options });
    }
  }
  return { ...undici, Agent: RecordedAgent };
});

afterEach(() => {
  agentOptions.length = 0;
  vi.unstubAllEnvs();
  vi.resetModules();
});

const finished = `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

/** Runs one real turn against a fake OpenAI-compatible server that answers with `respond`. */
async function runTurn(
  provider: "local" | "openai-compatible",
  respond: (response: ServerResponse) => void,
) {
  vi.stubEnv("RAKAZO_LOCAL_MODELS", "example-model");
  // One attempt: a retry would only repeat the same scripted response.
  vi.stubEnv("MODEL_STREAM_MAX_RETRIES", "0");
  vi.stubEnv("MODEL_STREAM_TIMEOUT_MS", "1000");
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => respond(response));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  vi.stubEnv("RAKAZO_LOCAL_MODELS_URL", baseUrl);
  // The model catalog reads the environment once, so each scenario loads a fresh one.
  vi.resetModules();
  const { PiAgentRuntime } = await import("./pi-runtime.js");
  try {
    const events = [];
    for await (const event of new PiAgentRuntime().run(
      {
        botId: "bot-fixture",
        threadId: "thread-fixture",
        runId: "run-transport",
        prompt: "Continue",
        instructions: "Answer briefly.",
        history: [],
        tools: [],
        model: {
          provider,
          id: "example-model",
          ...(provider === "local" ? {} : { baseUrl, allowPrivateEndpoint: true }),
        },
      },
      { signal: AbortSignal.timeout(15_000) },
    )) {
      events.push(event);
    }
    return events;
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

describe.each(["local", "openai-compatible"] as const)("%s model stream transport", (provider) => {
  it("leaves header and body waits to the runtime instead of undici's 5-minute limits", async () => {
    const events = await runTurn(provider, (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(finished);
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "done", text: "Ready" }));
    expect(agentOptions).toContainEqual(
      expect.objectContaining({ headersTimeout: 0, bodyTimeout: 0 }),
    );
  });

  it("names why a stream that started was cut off", async () => {
    await expect(
      runTurn(provider, (response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": still thinking\n\n", () => response.socket?.destroy());
      }),
    ).rejects.toThrow("terminated (other side closed)");
  });
});
