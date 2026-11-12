import type { AdapterContext } from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected } from "@rakazo/adapter-kit";
import type { McpServer, PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
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
          resourceMetadata: { resource: row.resource ?? row.endpoint, resource_name: row.name },
        }),
        tokens: async () =>
          row.token ? { access_token: row.token, scope: row.scope ?? OPERATE } : undefined,
        accessTokenExpiresAt: () => row.expiresAt,
        replaceRejectedToken: async () => {
          dropped.push(row.id);
          row.token = undefined;
          throw new Error("no refresh token");
        },
      };
    },
  } as unknown as Pick<McpOAuthBroker, "providerFor">;
  return { prisma, oauth, dropped, reads };
}

describe("T3 Code environments connected as MCP servers", () => {
  it("picks the actor's connected T3 Code server, skipping others", async () => {
    const rows = [
      server("other-tool", { name: "Docs" }),
      server("no-token", { token: undefined }),
      server("disabled", { enabled: false }),
      server("disconnected", { secretId: null }),
      server("t3"),
    ];
    const { prisma, oauth, reads } = fakes(rows);
    const connection = await new T3CodeConnections(prisma, oauth).forActor(actor);
    // The three candidates' stored logins are read together, not one after another.
    expect(reads.most).toBe(3);
    expect(connection).toMatchObject({
      key: "mcp:t3",
      baseUrl: "https://t3.example.test/mcp",
      spaceId: actor.spaceId,
    });
    expect(connection!.key).not.toContain(T3_TOKEN);
    const none = fakes([server("other-tool", { name: "Docs" }), server("x", { token: undefined })]);
    expect(await new T3CodeConnections(none.prisma, none.oauth).forActor(actor)).toBeNull();
  });

  it("offers only a grant that may still start work at the address T3 Code serves tools on", async () => {
    const rows = [
      server("read-only", { scope: "orchestration:read" }),
      server("lapsed", { expiresAt: Date.now() - 1000 }),
      server("base-url", { endpoint: "https://base-url.example.test/" }),
      // A launch this close to expiry would be refused as expired before it could start.
      server("lapsing", { expiresAt: Date.now() + 30_000 }),
    ];
    rows[2]!.resource = "https://base-url.example.test/mcp";
    const { prisma, oauth } = fakes(rows);
    const connections = new T3CodeConnections(prisma, oauth);
    expect(await connections.forActor(actor)).toBeNull();
    // Agents already running there still reach it, and end as expired once it refuses them.
    expect((await connections.forKey("mcp:lapsed", actor))!.baseUrl).toBe(rows[1]!.endpoint);
    rows.push(server("t3", { expiresAt: Date.now() + 5 * 60_000 }));
    expect((await connections.forActor(actor))!.key).toBe("mcp:t3");
  });

  it("keeps an agent's key across a reconnect and finds it again", async () => {
    const rows = [server("t3")];
    const { prisma, oauth } = fakes(rows);
    const connections = new T3CodeConnections(prisma, oauth);
    const before = await connections.forActor(actor);
    rows[0]!.token = "reconnected-token";
    const after = await connections.forKey(before!.key, actor);
    expect(after!.key).toBe(before!.key);
    expect(await connections.forKey("deployment-key", actor)).toBeNull();
  });

  it("refuses the agents of a removed or disabled server, so they end as expired", async () => {
    const rows = [server("t3", { enabled: false })];
    const { prisma, oauth } = fakes(rows);
    const connections = new T3CodeConnections(prisma, oauth);
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
    const { prisma, oauth } = fakes([server("broken"), server("t3")], ["broken"]);
    const connections = new T3CodeConnections(prisma, oauth);
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
