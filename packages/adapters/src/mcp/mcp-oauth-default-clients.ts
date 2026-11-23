import { parseMcpOAuthAuthorizationParams } from "@rakazo/contracts";
import { z } from "zod";

const ENV_NAME = "MCP_OAUTH_DEFAULT_CLIENTS";

function issuerHref(key: string): string | undefined {
  try {
    const url = new URL(key);
    const plain = !url.username && !url.password && !url.search && !url.hash;
    return url.protocol === "https:" && plain ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function httpsOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    const plain = !url.username && !url.password && !url.search && !url.hash;
    const exact = plain && url.pathname === "/" && !url.hostname.includes("*");
    return url.protocol === "https:" && exact ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

const DefaultClient = z.strictObject({
  client_id: z.string().trim().min(1),
  client_secret: z.string().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  authorization_params: z
    .string()
    .max(1000)
    .refine((value) => {
      try {
        parseMcpOAuthAuthorizationParams(value);
        return true;
      } catch {
        return false;
      }
    }, "must not set the OAuth flow's own parameters")
    .optional(),
  /** HTTPS origins of the MCP servers allowed to use this client. */
  servers: z.array(z.string()).min(1),
});

/** A client the operator registered with an authorization server for every user of the deployment. */
export type McpOAuthDefaultClient = z.infer<typeof DefaultClient>;

/** Default clients keyed by their authorization server's normalized issuer URL. */
export type McpOAuthDefaultClients = Readonly<Record<string, McpOAuthDefaultClient>>;

/**
 * Reads `MCP_OAUTH_DEFAULT_CLIENTS`. Errors name the offending key and rule, never a value,
 * because the JSON holds client secrets.
 */
export function parseMcpOAuthDefaultClients(raw: string | undefined): McpOAuthDefaultClients {
  if (!raw?.trim()) return {};
  const notAnObject = `${ENV_NAME} must be a JSON object keyed by authorization server issuer`;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(notAnObject);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json))
    throw new Error(notAnObject);
  const clients: Record<string, McpOAuthDefaultClient> = {};
  for (const [key, value] of Object.entries(json)) {
    const href = issuerHref(key);
    if (!href)
      throw new Error(
        `${ENV_NAME} keys must be https issuer URLs without credentials, query or fragment`,
      );
    const client = DefaultClient.safeParse(value);
    if (!client.success) {
      const problem = client.error.issues
        .map((issue) => [...issue.path, issue.message].join(": "))
        .join("; ");
      throw new Error(`${ENV_NAME} entry ${JSON.stringify(href)}: ${problem}`);
    }
    const origins = client.data.servers.map(httpsOrigin);
    // The offending value is left out: it may carry credentials.
    if (origins.some((origin) => !origin))
      throw new Error(
        `${ENV_NAME} entry ${JSON.stringify(href)}: servers must be https origins without credentials, path, query or fragment`,
      );
    if (Object.hasOwn(clients, href))
      throw new Error(`${ENV_NAME} lists ${JSON.stringify(href)} more than once`);
    clients[href] = { ...client.data, servers: [...new Set(origins as string[])] };
  }
  return clients;
}

/** The default for exactly this authorization server and a listed MCP server, so its secret goes nowhere else. */
export function defaultClientFor(
  clients: McpOAuthDefaultClients | undefined,
  authorizationServerUrl: string | undefined,
  mcpEndpoint: string | null | undefined,
): McpOAuthDefaultClient | undefined {
  if (!clients || !authorizationServerUrl || !mcpEndpoint) return undefined;
  const href = new URL(authorizationServerUrl).href;
  const client = Object.hasOwn(clients, href) ? clients[href] : undefined;
  return client?.servers.includes(new URL(mcpEndpoint).origin) ? client : undefined;
}

/**
 * The default that applies to a grant: only when the user entered no client and the server
 * registered none, and only for a listed MCP server. A stdio server has no endpoint, so it
 * never gets one.
 */
export function deploymentClient(
  material: {
    oauthClient?: unknown;
    oauth?: {
      clientInformation?: unknown;
      discoveryState?: { authorizationServerUrl?: string };
    };
  },
  defaults: McpOAuthDefaultClients | undefined,
  mcpEndpoint: string | null | undefined,
): McpOAuthDefaultClient | undefined {
  if (material.oauthClient || material.oauth?.clientInformation) return undefined;
  return defaultClientFor(
    defaults,
    material.oauth?.discoveryState?.authorizationServerUrl,
    mcpEndpoint,
  );
}

/**
 * Whether a default can supply the client for this server: its issuer too once discovery has
 * found it, and until then any default that lists the server's origin.
 */
export function defaultClientApplies(
  clients: McpOAuthDefaultClients,
  material: Parameters<typeof deploymentClient>[0],
  mcpEndpoint: string | null | undefined,
): boolean {
  if (!mcpEndpoint) return false;
  if (material.oauth?.discoveryState?.authorizationServerUrl)
    return (
      defaultClientFor(
        clients,
        material.oauth.discoveryState.authorizationServerUrl,
        mcpEndpoint,
      ) !== undefined
    );
  const origin = new URL(mcpEndpoint).origin;
  return Object.values(clients).some((client) => client.servers.includes(origin));
}

/** Every configured secret, for redaction wherever one could surface. */
export function defaultClientSecrets(clients: McpOAuthDefaultClients): string[] {
  return Object.values(clients).flatMap((client) =>
    client.client_secret ? [client.client_secret] : [],
  );
}
