import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRembricProvider, prepareRembricConnection } from "./rembric-memory-provider.js";

// Exercise the actual SDK + guarded remote transport, not a replacement MCP client.
describe("Rembric loopback MCP contract", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prepares, saves, recalls and archives only through the configured project URL", async () => {
    const calls: Array<{ path: string | undefined; name: string; args: unknown }> = [];
    const memory = {
      id: "memory-1",
      title: "Fact",
      content: "A durable fact",
      projectId: "project-1",
      scope: "project",
      status: "active",
    };
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (rpc.method === "initialize")
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "rembric-fixture", version: "1" },
        };
      else if (rpc.method === "tools/call") {
        const { name, arguments: args } = rpc.params;
        calls.push({ path: request.url, name, args });
        expect(request.headers.authorization).toBe("Bearer fake-rembric-token");
        const payload =
          name === "project.current"
            ? {
                slug: "team-notes",
                projectId: "project-1",
                source: "url-path",
                suggestedSlugs: [],
              }
            : name === "memory.save"
              ? {
                  id: "memory-1",
                  status: "active",
                  createdAt: "2026-01-01T00:00:00Z",
                  candidates: [],
                  judgmentRequired: false,
                  candidatesDetected: 0,
                }
              : name === "memory.search"
                ? {
                    count: 1,
                    memories: [memory],
                    abstained: false,
                    searchedProjects: ["team-notes"],
                  }
                : name === "memory.get_batch"
                  ? { memories: [memory], errors: [], total: 1, nextOffset: null }
                  : { ok: true, id: "memory-1", status: "archived" };
        // Rembric provides both structured output and matching JSON text.
        result = {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      } else {
        response.writeHead(400).end();
        return;
      }
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test server address");
      const endpoint = `http://127.0.0.1:${address.port}/mcp/team-notes`;
      await expect(
        prepareRembricConnection(
          { endpoint },
          { token: "fake-rembric-token" },
          { spaceId: "space-1" },
        ),
      ).rejects.toThrow();
      expect(calls).toEqual([]);
      const prepared = await prepareRembricConnection(
        { endpoint },
        { token: "fake-rembric-token" },
        { spaceId: "space-1", allowPrivateEndpoint: true },
      );
      vi.stubEnv("MCP_ALLOW_PRIVATE_ENDPOINT", "true");
      const provider = createRembricProvider(prepared.settings, prepared.credentials);
      const context = {
        operationId: "op-1",
        traceId: "trace-1",
        spaceId: "space-1",
        userId: "user-1",
        signal: new AbortController().signal,
      };
      const shared = { botId: "bot-1", scope: "shared" as const };
      expect(
        (
          await provider.save(
            { ...shared, content: memory.content, source: { kind: "durable" } },
            context,
          )
        ).ok,
      ).toBe(true);
      expect(await provider.recall({ ...shared, query: "fact", limit: 5 }, context)).toEqual({
        ok: true,
        value: [{ id: memory.id, memory: memory.content, score: 0, entity: "space-space-1" }],
      });
      expect((await provider.forget({ ...shared, id: memory.id }, context)).ok).toBe(true);
      expect(calls.every((call) => call.path === "/mcp/team-notes")).toBe(true);
      expect(
        calls
          .filter((call) => call.name !== "project.current")
          .map(({ name, args }) => [name, args]),
      ).toEqual([
        [
          "memory.save",
          { type: "project", title: memory.content, content: memory.content, tags: ["rakazo"] },
        ],
        ["memory.search", { query: "fact", status: "active", limit: 5 }],
        ["memory.get_batch", { ids: [memory.id] }],
        ["memory.archive", { id: memory.id }],
      ]);
      vi.stubEnv("MCP_ALLOW_PRIVATE_ENDPOINT", "false");
      const count = calls.length;
      expect((await provider.recall({ ...shared, query: "fact", limit: 5 }, context)).ok).toBe(
        false,
      );
      expect(calls).toHaveLength(count);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
