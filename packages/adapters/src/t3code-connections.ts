import type { McpServer, PrismaClient } from "@rakazo/db";
import { availableInSpace } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type {
  CloudAgentActor,
  CloudAgentConnection,
  UserCloudAgents,
} from "./cloud-agent-factory.js";
import { USER_CLOUD_AGENT_KEY_PREFIX } from "./cloud-agent-factory.js";
import type { McpOAuthBroker } from "./mcp-oauth.js";
import { TOKEN_REFRESH_SKEW_MS } from "./mcp-oauth.js";
import type { T3CodeCloudAgentOptions } from "./t3code-cloud-agent.js";
import { T3CodeCloudAgentProvider } from "./t3code-cloud-agent.js";

/**
 * T3 Code environments that users connected as remote MCP servers, as cloud-agent connections.
 * T3 Code names itself in the protected-resource metadata stored when the server was connected.
 */
export class T3CodeConnections implements UserCloudAgents {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly oauth: Pick<McpOAuthBroker, "providerFor">,
    private readonly transport: Pick<
      T3CodeCloudAgentOptions,
      "fetch" | "resolveHostname" | "allowPrivateEndpoint"
    > = {},
  ) {}

  /** The actor's first connected environment available in the Space and to these agents. */
  async forActor(
    actor: CloudAgentActor & { botIds?: string[] },
  ): Promise<CloudAgentConnection | null> {
    return (await this.connections(actor, true))[0] ?? null;
  }

  async listForActor(actor: CloudAgentActor): Promise<CloudAgentConnection[]> {
    return this.connections(actor, false);
  }

  private async connections(
    { botIds, ...actor }: CloudAgentActor & { botIds?: string[] },
    firstOnly: boolean,
  ) {
    const servers = await this.prisma.mcpServer.findMany({
      where: {
        ...usable(actor),
        secretId: { not: null },
        // The same per-agent access the server's own tools follow.
        ...(botIds && {
          AND: [
            {
              OR: [
                { allBots: true },
                { assignments: { some: { botId: { in: botIds }, spaceId: actor.spaceId } } },
              ],
            },
          ],
        }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const found: CloudAgentConnection[] = [];
    for (const server of servers) {
      try {
        const connection = await this.connect(server, actor, true);
        if (connection) found.push(connection);
        if (connection && firstOnly) break;
      } catch (error) {
        // One unreadable server must not hide the others or the deployment's provider.
        getLogger().warn("cloud_agent.connection_unreadable", {
          "mcp.server.id": server.id,
          error,
        });
      }
    }
    return found;
  }

  async forKey(key: string, actor: CloudAgentActor): Promise<CloudAgentConnection | null> {
    if (!key.startsWith(USER_CLOUD_AGENT_KEY_PREFIX)) return null;
    const server = await this.prisma.mcpServer.findFirst({
      where: { id: key.slice(USER_CLOUD_AGENT_KEY_PREFIX.length), ...usable(actor) },
    });
    // A server its owner removed, disabled or disconnected refuses every call, so its agents
    // end as expired instead of polling forever.
    return (
      (server && (await this.connect(server, actor, false))) ?? {
        key,
        spaceId: actor.spaceId,
        provider: new T3CodeCloudAgentProvider({ endpoint: "", token: undefined }),
      }
    );
  }

  private async connect(server: McpServer, actor: CloudAgentActor, connectedOnly: boolean) {
    const oauth = await this.oauth.providerFor(server, actor);
    const resource = oauth?.discoveryState()?.resourceMetadata;
    // T3 Code serves its sign-in at any of its addresses but its tools only at this one.
    if (
      !oauth ||
      resource?.resource_name !== "T3 Code" ||
      !sameUrl(resource.resource, server.endpoint)
    )
      return null;
    const tokens = await oauth.tokens();
    const token = tokens?.access_token;
    // New agents need a grant that may start work, one that has not lapsed: T3 Code's approval
    // page starts at read only, and it issues no refresh token.
    if (
      connectedOnly &&
      (!token ||
        (tokens?.scope !== undefined && !tokens.scope.split(" ").includes(OPERATE_SCOPE)) ||
        Date.now() >=
          (oauth.accessTokenExpiresAt() ?? Number.POSITIVE_INFINITY) - TOKEN_REFRESH_SKEW_MS)
    )
      return null;
    return {
      key: `${USER_CLOUD_AGENT_KEY_PREFIX}${server.id}`,
      baseUrl: server.endpoint!,
      spaceId: actor.spaceId,
      provider: new T3CodeCloudAgentProvider({
        ...this.transport,
        endpoint: server.endpoint!,
        token,
        // T3 Code issues no refresh token, so this drops it and the server asks to be
        // connected again wherever MCP servers are listed.
        onTokenRejected: () => oauth.replaceRejectedToken(),
      }),
    };
  }
}

const OPERATE_SCOPE = "orchestration:operate";

function sameUrl(a: string | undefined, b: string | null) {
  const normal = (url: string) => {
    try {
      return new URL(url).href.replace(/\/$/, "");
    } catch {
      return url;
    }
  };
  return a === undefined || (b !== null && normal(a) === normal(b));
}

function usable(actor: CloudAgentActor) {
  return { enabled: true, endpoint: { not: null }, ...availableInSpace(actor) };
}
