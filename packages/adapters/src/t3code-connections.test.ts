import type { AdapterContext } from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected } from "@rakazo/adapter-kit";
import type { McpServer, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { cloudAgentForActor } from "./cloud-agent-service.js";
import type { McpOAuthBroker } from "./mcp-oauth.js";
import { T3CodeConnections } from "./t3code-connections.js";
import { T3_TOKEN, T3McpEmulator } from "./t3code-mcp-emulator.test-support.js";

const actor = { spaceId: "space-1", userId: "user-1" };
const OPERATE = "orchestration:read orchestration:operate";
const ctx: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  ...actor,
  signal: new AbortController().signal,
};

type Row = Pick<McpServer, "id" | "userId" | "enabled" | "endpoint" | "secretId"> & {
  name: string;
  token?: string;
  scope?: string;
  expiresAt?: number;
  resource?: string;
  revision?: number;
  issuer?: string;
  scopesSupported?: string[];
};

function server(id: string, overrides: Partial<Row> & { name?: string } = {}): Row {
  return {
    id,
    userId: actor.userId,
    enabled: true,
    endpoint: `https://${id}.example.test/mcp`,
    secretId: `secret-${id}`,
    name: "T3 Code",
    token: T3_TOKEN,
    scope: OPERATE,
    ...overrides,
  };
}

/** Applies the row filters the store applies: owner, enabled, has an endpoint and, if asked, a secret. */
function fakes(rows: Row[], unreadable: string[] = []) {
  const matches = (row: Row, where: Record<string, unknown>) =>
    row.userId === actor.userId &&
    row.enabled &&
    row.endpoint !== null &&
    (!("secretId" in where) || row.secretId !== null) &&
    (!("id" in where) || row.id === where.id);
  const prisma = {
    mcpServer: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((row) => matches(row, where)),
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matches(row, where)) ?? null,
    },
  } as unknown as PrismaClient;
  const dropped: string[] = [];
  const reads = { open: 0, most: 0 };
  const oauth = {
    providerFor: async (row: Row) => {
      reads.open += 1;
      reads.most = Math.max(reads.most, reads.open);
      await Promise.resolve();
      reads.open -= 1;
      if (unreadable.includes(row.id)) throw new Error("secret store unavailable");
      return {
        discoveryState: () => ({
          authorizationServerUrl: row.issuer ?? new URL(row.endpoint!).origin,
          resourceMetadata: {
            resource: row.resource ?? row.endpoint,
            resource_name: row.name,
            scopes_supported: row.scopesSupported,
          },
        }),
        tokens: async () => (row.token ? { access_token: row.token, scope: row.scope } : undefined),
        accessTokenExpiresAt: () => row.expiresAt,
        replaceRejectedToken: async () => {
          dropped.push(row.id);
          row.token = undefined;
          throw new Error("no refresh token");
        },
      };
    },
  } as unknown as Pick<McpOAuthBroker, "providerFor">;
  const emulators = new Map<string, T3McpEmulator>();
  const transport = {
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const origin = new URL(request.url).origin;
      let emulator = emulators.get(origin);
      if (!emulator) {
        emulator = new T3McpEmulator();
        if (new URL(request.url).hostname.startsWith("other-tool")) emulator.tools = [];
        emulators.set(origin, emulator);
      }
      return emulator.fetch(request);
    },
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
  };
  return { prisma, oauth, dropped, reads, transport };
}

describe("T3 Code environments connected as MCP servers", () => {
  it("accepts every representative protocol call against the real advertised schemas", async () => {
    const f = fakes([server("t3")]);
    const m = new T3McpEmulator();
    // forActor checks every PROTOCOL call, including the unconstrained model selection.
    const connections = new T3CodeConnections(f.prisma, f.oauth, {
      ...f.transport,
      fetch: m.fetch,
    });
    expect(await connections.forActor(actor)).not.toBeNull();
    expect(m.listCalls).toBe(1);
  });

  it.each([
    [{}, true],
    [{ description: "Model", title: "Model", default: null, examples: ["model"] }, true],
    [true, true],
    [false, false],
    [{ minimum: 1 }, false],
    [{ unknownConstraint: true }, false],
  ])("handles unconstrained property schema %j (compatible: %s)", async (schema, compatible) => {
    const f = fakes([server("t3")]);
    const m = new T3McpEmulator();
    const selection = m.tools[1]!.inputSchema.properties.modelSelection as {
      properties: Record<string, unknown>;
    };
    selection.properties.instanceId = schema;
    selection.properties.model = schema;
    const connections = new T3CodeConnections(f.prisma, f.oauth, {
      ...f.transport,
      fetch: m.fetch,
    });
    expect((await connections.forActor(actor)) !== null).toBe(compatible);
  });

  it("rejects label-only and incompatible protocols and falls back to deployment", async () => {
    const deployment = { key: "deployment", spaceId: actor.spaceId } as CloudAgentConnection;
    for (const mutate of [
      (m: T3McpEmulator) => {
        m.tools = [
          {
            name: "search",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
              additionalProperties: false,
            },
          },
        ];
      },
      (m: T3McpEmulator) => {
        m.tools.pop();
      },
      (m: T3McpEmulator) => {
        m.tools[3]!.inputSchema.properties.mode = { enum: ["steer"] };
      },
      (m: T3McpEmulator) => {
        m.tools[1]!.inputSchema.properties.modelSelection = {
          type: "object",
          properties: { instanceId: { type: "string" }, model: { type: "string" } },
          required: ["secret"],
        };
      },
      (m: T3McpEmulator) => {
        m.tools = [];
      },
      (m: T3McpEmulator) => {
        m.tools[1]!.inputSchema = {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        };
      },
      (m: T3McpEmulator) => {
        m.tools[2]!.inputSchema.properties.threadId = { type: "number" };
      },
      (m: T3McpEmulator) => {
        m.tools[1]!.inputSchema.required = ["unsupported"];
      },
      (m: T3McpEmulator) => {
        m.failList = true;
      },
      (m: T3McpEmulator) => {
        // Every tool name, but schemas that describe nothing.
        for (const tool of m.tools) tool.inputSchema = {} as typeof tool.inputSchema;
      },
      (m: T3McpEmulator) => {
        m.tools[1]!.inputSchema.properties.workspaceStrategy = {};
      },
    ]) {
      const m = new T3McpEmulator();
      mutate(m);
      const f = fakes([server("t3")]);
      const connections = new T3CodeConnections(f.prisma, f.oauth, {
        ...f.transport,
        fetch: m.fetch,
      });
      expect(
        await cloudAgentForActor({ cloudAgent: deployment, userCloudAgents: connections }, actor),
      ).toBe(deployment);
      expect((await connections.forKey("mcp:t3", actor))!.baseUrl).toBe(
        "https://t3.example.test/mcp",
      );
    }
  });

  it("ignores display labels and caches discoveries until the token changes", async () => {
    const rows = [server("t3", { name: "Anything" })];
    const f = fakes(rows);
    const m = new T3McpEmulator();
    const connections = new T3CodeConnections(f.prisma, f.oauth, {
      ...f.transport,
      fetch: m.fetch,
    });
    const [connection, concurrent] = await Promise.all([
      connections.forActor(actor),
      connections.forActor(actor),
    ]);
    expect(concurrent).not.toBeNull();
    const launched = await connection!.provider.launch(
      { prompt: "Task", idempotencyKey: "request" },
      ctx,
    );
    expect((await connection!.provider.get(launched.id, ctx)).status).toBe("running");
    expect(await connections.listForActor(actor)).toHaveLength(1);
    expect(m.listCalls).toBe(1);
    rows[0]!.token = m.token = "replacement";
    expect(await connections.forActor(actor)).not.toBeNull();
    expect(m.listCalls).toBe(2);
    rows[0]!.revision = 2;
    await connections.forActor(actor);
    expect(m.listCalls).toBe(3);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    try {
      await connections.forActor(actor);
      expect(m.listCalls).toBe(4);
    } finally {
      clock.mockRestore();
    }
  });

  it("reads local schema references without fetching external references", async () => {
    const f = fakes([server("t3")]);
    const m = new T3McpEmulator();
    const schema = m.tools[2]!.inputSchema as Record<string, unknown>;
    schema.$defs = { id: { type: "string" } };
    m.tools[2]!.inputSchema.properties.threadId = { $ref: "#/$defs/id" };
    const connections = new T3CodeConnections(f.prisma, f.oauth, {
      ...f.transport,
      fetch: m.fetch,
    });
    expect(await connections.forActor(actor)).not.toBeNull();
    m.tools[2]!.inputSchema.properties.threadId = { $ref: "https://schemas.example.test/id" };
    const fresh = new T3CodeConnections(f.prisma, f.oauth, { ...f.transport, fetch: m.fetch });
    expect(await fresh.forActor(actor)).toBeNull();
  });

  it("bounds work across branching cyclic and acyclic schema alternatives", async () => {
    for (const cyclic of [true, false]) {
      const f = fakes([server("t3")]);
      const m = new T3McpEmulator();
      const schema = m.tools[0]!.inputSchema as Record<string, unknown>;
      const definitions: Record<string, unknown> = {};
      for (let i = 0; i < 8; i++) {
        definitions[`level${i}`] = {
          anyOf: Array.from({ length: 16 }, () => ({
            $ref: `#/$defs/level${cyclic ? 0 : i + 1}`,
          })),
        };
      }
      definitions.level8 = false;
      schema.$defs = definitions;
      schema.$ref = "#/$defs/level0";
      const connections = new T3CodeConnections(f.prisma, f.oauth, {
        ...f.transport,
        fetch: m.fetch,
      });
      expect(await connections.forActor(actor)).toBeNull();
    }
  });

  it("picks the actor's connected T3 Code server, skipping others", async () => {
    const rows = [
      server("other-tool", { name: "Docs" }),
      server("no-token", { token: undefined }),
      server("disabled", { enabled: false }),
      server("disconnected", { secretId: null }),
      server("t3"),
    ];
    const { prisma, oauth, reads, transport } = fakes(rows);
    const connection = await new T3CodeConnections(prisma, oauth, transport).forActor(actor);
    // The three candidates' stored logins are read together, not one after another.
    expect(reads.most).toBe(3);
    expect(connection).toMatchObject({
      key: "mcp:t3",
      baseUrl: "https://t3.example.test/mcp",
      spaceId: actor.spaceId,
    });
    expect(connection!.key).not.toContain(T3_TOKEN);
    const none = fakes([server("other-tool", { name: "Docs" }), server("x", { token: undefined })]);
    expect(
      await new T3CodeConnections(none.prisma, none.oauth, none.transport).forActor(actor),
    ).toBeNull();
  });

  it("offers only a grant that may still start work at the address T3 Code serves tools on", async () => {
    const rows = [
      server("wrong-issuer", { issuer: "https://auth.example.test" }),
      server("wrong-scopes", { scopesSupported: ["read", "write"] }),
      server("missing-scope", { scope: undefined }),
      server("read-only", { scope: "orchestration:read" }),
      server("lapsed", { expiresAt: Date.now() - 1000 }),
      server("base-url", { endpoint: "https://base-url.example.test/" }),
      // A launch this close to expiry would be refused as expired before it could start.
      server("lapsing", { expiresAt: Date.now() + 30_000 }),
    ];
    rows.find((row) => row.id === "base-url")!.resource = "https://base-url.example.test/mcp";
    const { prisma, oauth, transport } = fakes(rows);
    const connections = new T3CodeConnections(prisma, oauth, transport);
    expect(await connections.forActor(actor)).toBeNull();
    // Agents already running there still reach it, and end as expired once it refuses them.
    expect((await connections.forKey("mcp:lapsed", actor))!.baseUrl).toBe(
      rows.find((row) => row.id === "lapsed")!.endpoint,
    );
    rows.push(server("t3", { expiresAt: Date.now() + 5 * 60_000 }));
    expect((await connections.forActor(actor))!.key).toBe("mcp:t3");
  });

  it("keeps an agent's key across a reconnect and finds it again", async () => {
    const rows = [server("t3")];
    const { prisma, oauth, transport } = fakes(rows);
    const connections = new T3CodeConnections(prisma, oauth, transport);
    const before = await connections.forActor(actor);
    rows[0]!.token = "reconnected-token";
    const after = await connections.forKey(before!.key, actor);
    expect(after!.key).toBe(before!.key);
    expect(await connections.forKey("deployment-key", actor)).toBeNull();
  });

  it("refuses the agents of a removed or disabled server, so they end as expired", async () => {
    const rows = [server("t3", { enabled: false })];
    const { prisma, oauth, transport } = fakes(rows);
    const connections = new T3CodeConnections(prisma, oauth, transport);
    for (const key of ["mcp:t3", "mcp:gone"]) {
      const connection = await connections.forKey(key, actor);
      expect(connection!.key).toBe(key);
      const error = await connection!.provider.get("thread-1", ctx).catch((cause) => cause);
      expect(error).toBeInstanceOf(CloudAgentRequestRejected);
      expect((error as CloudAgentRequestRejected).reason).toBe("expired");
    }
  });

  it("drops a rejected token so the server asks for a reconnect", async () => {
    const emulator = new T3McpEmulator();
    const rows = [server("t3")];
    const { prisma, oauth, dropped } = fakes(rows);
    const connections = new T3CodeConnections(prisma, oauth, {
      fetch: emulator.fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    });
    const connection = (await connections.forActor(actor))!;
    emulator.token = "revoked";
    const error = await connection.provider.get("thread-1", ctx).catch((cause) => cause);
    expect((error as CloudAgentRequestRejected).reason).toBe("expired");
    expect(dropped).toEqual(["t3"]);
    // Without a token the server is no longer offered for new agents.
    expect(await connections.forActor(actor)).toBeNull();
  });

  it("skips an unreadable server and keeps the deployment's provider when none can be read", async () => {
    const { prisma, oauth, transport } = fakes([server("broken"), server("t3")], ["broken"]);
    const connections = new T3CodeConnections(prisma, oauth, transport);
    expect((await connections.forActor(actor))!.key).toBe("mcp:t3");
    expect((await connections.listForActor(actor)).map((entry) => entry.key)).toEqual(["mcp:t3"]);
    const deployment = {
      key: "deployment",
      spaceId: actor.spaceId,
      provider: { describe: () => ({ capabilities: { offline: false } }) },
    } as unknown as CloudAgentConnection;
    const failing = {
      forActor: async () => {
        throw new Error("database unavailable");
      },
      forKey: async () => null,
      listForActor: async () => [],
    };
    expect(
      await cloudAgentForActor({ cloudAgent: deployment, userCloudAgents: failing }, actor),
    ).toBe(deployment);
  });
});
