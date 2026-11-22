import {
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { PluginMarketplaceEntry } from "@rakazo/contracts";
import { anySignal, deadlineSignal, withAbort } from "@rakazo/core";
import { secureFetch } from "../mcp/mcp-transport.js";
import type { RemoteTransportDependencies } from "../mcp/remote-mcp.js";
import type {
  PluginMcpServerEntry,
  PluginRepoFetcher,
  PluginTextReader,
} from "./plugin-connectors.js";
import {
  parsePluginDirectory,
  parsePluginSource,
  previewPluginInstall,
} from "./plugin-connectors.js";
import { createPluginMarketplace, publicRead } from "./plugin-marketplace.js";

/** A marketplace plugin's remote connector, as a bot can offer it from chat. */
export type MarketplaceConnector = {
  name: string;
  description: string;
  logo: string | null;
  server: PluginMcpServerEntry;
};

export type MarketplaceConnectors = {
  /** The listed plugin named `app` when it brings exactly one remote server that needs no
   * credentials typed in, which is what a sign-in card can connect; otherwise null. */
  find(app: string, signal: AbortSignal): Promise<MarketplaceConnector | null>;
};

const FULL_SHA = /^[a-f0-9]{40}$/;
/** The files that declare a plugin and its MCP servers, which is all a connector needs. */
const CONNECTOR_FILES = [
  "plugin.json",
  ".cursor-plugin/plugin.json",
  ".grok-plugin/plugin.json",
  "mcp.json",
  ".mcp.json",
];

/**
 * The servers a plugin pinned to a commit declares, read from only its declaration files at that
 * commit. A plugin that also bundles hundreds of skills is more than a full preview fetches, and
 * none of them matter here. Null for a plugin pinned to no commit.
 */
async function pinnedServers(source: string, read: PluginTextReader, signal: AbortSignal) {
  const ref = parsePluginSource(source);
  if (!ref.ref || !FULL_SHA.test(ref.ref)) return null;
  const repo = new URL(ref.gitUrl).pathname;
  const dir = ref.subdir ? `${ref.subdir.split("/").map(encodeURIComponent).join("/")}/` : "";
  const files = await Promise.all(
    CONNECTOR_FILES.map(async (path) => {
      try {
        const url = `https://raw.githubusercontent.com${repo}/${ref.ref}/${dir}${path}`;
        return [{ path, content: await read(url, 256_000, signal) }];
      } catch (error) {
        // Most of these files are optional; only a confirmed missing one is left out.
        if (error instanceof Error && error.message === "Request failed: HTTP 404") return [];
        throw error;
      }
    }),
  );
  return parsePluginDirectory({ files: files.flat(), resolvedSha: ref.ref }).mcpServers;
}

/** How long the sign-in check may take before the lookup gives up on the server. */
const SIGN_IN_CHECK_MS = 10_000;

async function probe(url: URL, fetchFn: typeof fetch): Promise<boolean> {
  const challenge = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "rakazo", version: "0.1.0" },
      },
    }),
  });
  // Read as sign-in reads it, quoted or not.
  const { resourceMetadataUrl } =
    challenge.status === 401 ? extractWWWAuthenticateParams(challenge) : {};
  await challenge.body?.cancel();
  const { authorizationServerMetadata } = await discoverOAuthServerInfo(url, {
    resourceMetadataUrl,
    fetchFn,
  });
  return !authorizationServerMetadata || Boolean(authorizationServerMetadata.registration_endpoint);
}

/**
 * Whether one tap can start the server's sign-in: its authorization server registers Rakazo as a
 * client by itself (RFC 7591), or it publishes no authorization server at all. One that needs a
 * client registered by hand is set up in Settings instead, so chat does not offer it. The server
 * is asked first, as sign-in does, since some name their metadata only in their 401 challenge.
 */
async function signsInByItself(
  endpoint: string,
  network: RemoteTransportDependencies,
  signal: AbortSignal,
): Promise<boolean> {
  const url = new URL(endpoint);
  const safe = secureFetch(url, {}, {}, network);
  // Ending the check also drops any answer whose body nobody read.
  const done = new AbortController();
  const checkSignal = deadlineSignal(SIGN_IN_CHECK_MS, anySignal([signal, done.signal]));
  const fetchFn: typeof fetch = (input, init) => safe(input, { ...init, signal: checkSignal });
  try {
    // The whole check, the server's address lookup included, ends by the deadline.
    return await withAbort(probe(url, fetchFn), checkSignal);
  } finally {
    done.abort();
    await safe.close();
  }
}

const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

function named(entry: PluginMarketplaceEntry, app: string): boolean {
  const wanted = key(app);
  return [entry.name, entry.displayName].some((name) => key(name) === wanted);
}

export function createMarketplaceConnectors(
  options: {
    read?: PluginTextReader;
    fetcher?: PluginRepoFetcher;
    /** How the servers' sign-in metadata is reached. */
    network?: RemoteTransportDependencies;
  } = {},
): MarketplaceConnectors {
  const read = options.read ?? publicRead;
  const marketplace = createPluginMarketplace(read);
  return {
    async find(app, signal) {
      const { entries } = await marketplace.catalog(app);
      const entry = entries.find((candidate) => candidate.hasConnector && named(candidate, app));
      if (!entry) return null;
      // The commit the listing pins, or the registry's current one for a listing that pins none,
      // as installing it from the marketplace would.
      const servers =
        (await pinnedServers(entry.source, read, signal)) ??
        (await previewPluginInstall({ source: entry.source, fetcher: options.fetcher, signal }))
          .mcpServers;
      const [server, ...more] = servers;
      if (!server || more.length || Object.keys(server.headers).length) return null;
      if (!(await signsInByItself(server.endpoint, options.network ?? {}, signal))) return null;
      return {
        name: entry.displayName,
        description: entry.description,
        logo: entry.logo,
        server,
      };
    },
  };
}
