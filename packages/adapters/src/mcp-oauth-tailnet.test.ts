import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpOAuthBroker } from "./mcp-oauth.js";
import type { TailnetRoute } from "./tailnet-fetch.js";

const ORIGIN = "http://mcp.tail1234.ts.net";
const ACTOR = { spaceId: "home", userId: "alice" };
const REDIRECT = "https://rakazo.example.test/mcp/oauth/callback";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** An MCP server that signs in with OAuth and is its own authorization server. */
async function oauthServer(): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = [];
  const json = (response: ServerResponse, status: number, body: unknown) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    for await (const _chunk of request);
    const path = new URL(request.url ?? "/", ORIGIN).pathname;
    requests.push(`${request.method} ${path}`);
    if (path === "/mcp")
      return response
        .writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end();
    if (path === "/.well-known/oauth-protected-resource/mcp")
      return json(response, 200, { resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    if (path === "/.well-known/oauth-authorization-server")
      return json(response, 200, {
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        registration_endpoint: `${ORIGIN}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      });
    if (path === "/register")
      return json(response, 201, {
        client_id: "tailnet-client",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
      });
    if (path === "/token")
      return json(response, 200, {
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "bearer",
        expires_in: 3600,
      });
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return { port: (server.address() as AddressInfo).port, requests };
}

/** A bot's node that reaches every tailnet destination at one local port. */
function nodeTo(port: number): { route: TailnetRoute; dials: string[] } {
  const dials: string[] = [];
  const sockets: Socket[] = [];
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
  });
  return {
    dials,
    route: {
      async dial(destination) {
        dials.push(`${destination.host}:${destination.port}`);
        const socket = connect(port, "127.0.0.1");
        sockets.push(socket);
        await once(socket, "connect");
        return socket;
      },
    },
  };
}

function broker() {
  const sessions = new Map<string, Record<string, unknown>>();
  const server = { id: "server-1", endpoint: `${ORIGIN}/mcp`, secretId: null, revision: 1 };
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    mcpServer: {
      findFirst: vi.fn().mockResolvedValue(server),
      update: vi.fn().mockResolvedValue({ revision: 2 }),
    },
    secret: {
      findFirst: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    ...tx,
    mcpOAuthSession: {
      count: async () => sessions.size,
      create: async ({ data }: { data: Record<string, unknown> & { id: string } }) => {
        sessions.set(data.id, { ...data, createdAt: new Date() });
      },
      findFirst: async ({ where }: { where: { id: string } }) => sessions.get(where.id) ?? null,
      deleteMany: async ({ where }: { where: { id?: string } }) => {
        const removed = where.id && sessions.delete(where.id) ? 1 : 0;
        return { count: removed };
      },
    },
    deploymentSettings: { findUnique: async () => ({ ownerUserId: "alice" }) },
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  };
  let stored = 0;
  const put = async (plaintext: string) => {
    stored += 1;
    return { id: `secret-${stored}`, ciphertext: plaintext };
  };
  // The server's own network sees a tailnet address, which it must never reach itself.
  const network = {
    fetch: () => Promise.reject(new Error("the server's own network was used")),
    resolveHostname: async () => [{ address: "100.101.102.103", family: 4 }],
  };
  return { broker: new McpOAuthBroker(prisma as never, { put } as never, network), tx };
}

describe("signing in to an MCP server on a member's tailnet", () => {
  it("discovers, registers and exchanges the code through the member's bot node", async () => {
    const { port, requests } = await oauthServer();
    const node = nodeTo(port);
    const { broker: oauth, tx } = broker();
    const tailnet = vi.fn(async (target: string) =>
      new URL(target).hostname.endsWith(".ts.net") ? node.route : undefined,
    );

    const started = await oauth.begin({
      serverId: "server-1",
      ...ACTOR,
      redirectUri: REDIRECT,
      tailnet,
    });
    if (started.status !== "authorization_required") throw new Error("OAuth was not requested");
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.origin).toBe(ORIGIN);
    expect(authorization.searchParams.get("client_id")).toBe("tailnet-client");

    await oauth.complete({
      sessionId: started.sessionId,
      state: started.sessionId,
      code: "code",
      ...ACTOR,
      tailnet,
    });
    expect(requests).toEqual(
      expect.arrayContaining(["POST /mcp", "POST /register", "POST /token"]),
    );
    expect(new Set(node.dials)).toEqual(new Set(["mcp.tail1234.ts.net:80"]));
    expect(tx.mcpServer.update).toHaveBeenCalled();
  });

  it("asks for a bot on the tailnet before using up the sign-in", async () => {
    const { port } = await oauthServer();
    const node = nodeTo(port);
    const { broker: oauth } = broker();
    const started = await oauth.begin({
      serverId: "server-1",
      ...ACTOR,
      redirectUri: REDIRECT,
      tailnet: async () => node.route,
    });
    if (started.status !== "authorization_required") throw new Error("OAuth was not requested");
    const complete = (tailnet: () => Promise<TailnetRoute>) =>
      oauth.complete({
        sessionId: started.sessionId,
        state: started.sessionId,
        code: "code",
        ...ACTOR,
        tailnet,
      });
    await expect(complete(() => Promise.reject(new Error("no bot")))).rejects.toThrow("no bot");
    await expect(complete(async () => node.route)).resolves.toMatchObject({
      serverId: "server-1",
    });
  });

  it("refuses to start without a route, as the server's own network can't reach it", async () => {
    const { broker: oauth } = broker();
    await expect(
      oauth.begin({ serverId: "server-1", ...ACTOR, redirectUri: REDIRECT }),
    ).rejects.toThrow();
  });
});
