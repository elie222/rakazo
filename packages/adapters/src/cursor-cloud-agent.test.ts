import type { AdapterContext } from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";
import { CursorCloudAgentEmulator } from "./testing/cursor-cloud-agent-emulator.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

describe("Cursor HTTP boundary", () => {
  it("keeps a duplicate create recoverable when the accepted agent is not yet readable", async () => {
    const provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (_url, init) =>
        new Response(null, { status: init?.method === "POST" ? 409 : 404 }),
    });
    const error = await provider
      .launch({ idempotencyKey: "operation", prompt: "Task" }, context)
      .catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CloudAgentRequestRejected);
  });
  it("sends the documented create shape with a stable client agent ID", async () => {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    const result = await provider.launch(
      {
        idempotencyKey: "operation",
        prompt: "Task",
        repository: "https://github.com/example/demo",
        openPr: false,
        images: [{ data: "ZmFrZQ==", mimeType: "image/png" }],
      },
      context,
    );
    expect(wire.requests[0]).toEqual({
      method: "POST",
      path: "/v1/agents",
      body: {
        agentId: result.id,
        prompt: { text: "Task", images: [{ data: "ZmFrZQ==", mimeType: "image/png" }] },
        repos: [{ url: "https://github.com/example/demo" }],
        autoCreatePR: false,
      },
    });
    expect(result.id).toMatch(
      /^bc-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
  });
  it.each([400, 401, 403, 404, 422, 429, 500, 503])(
    "never exposes a %s response body",
    async (status) => {
      const provider = new CursorCloudAgentProvider({
        apiKey: "fake-key",
        fetch: async () => new Response("fake-key and fake-secret", { status }),
      });
      const error = await provider.get("test-agent", context).catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toMatch(/fake-key|fake-secret/);
    },
  );
  it("rejects malformed and oversized response bodies", async () => {
    for (const body of ['{"bad":true}', "invalid fake-secret", " ".repeat(1_000_001)]) {
      const provider = new CursorCloudAgentProvider({
        apiKey: "fake-key",
        fetch: async () => new Response(body),
      });
      await expect(provider.get("test-agent", context)).rejects.toThrow();
    }
  });
  it("bounds hanging body reads even if stream cancellation never settles", async () => {
    const provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      timeoutMs: 20,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull: () => new Promise(() => {}),
            cancel: () => new Promise(() => {}),
          }),
        ),
    });
    await expect(provider.get("test-agent", context)).rejects.toThrow();
  });
  it("uses a fixed credential origin and rejects redirects", async () => {
    let redirect: RequestRedirect | undefined;
    const provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (url, init) => {
        expect(String(url).startsWith("https://api.cursor.com/v1/agents/")).toBe(true);
        redirect = init?.redirect;
        return new Response(null, { status: 302 });
      },
    });
    await expect(provider.get("test-agent", context)).rejects.toThrow();
    expect(redirect).toBe("error");
  });
  it("does not turn a successful follow-up into failure by fetching metadata afterward", async () => {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    const agent = await provider.launch({ idempotencyKey: "follow-up", prompt: "Task" }, context);
    wire.complete(agent.id);
    wire.requests.length = 0;
    await provider.reply(agent.id, { prompt: "Tests" }, context);
    expect(wire.requests.map((request) => request.method)).toEqual(["GET", "POST"]);
  });
});
