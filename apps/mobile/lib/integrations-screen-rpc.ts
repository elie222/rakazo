import type {
  CapabilityInstall,
  Connection,
  ConnectionCatalogItem,
  McpServer,
  McpSourcePreset,
  PluginMarketplaceEntry,
  RpcInput,
} from "@rakazo/contracts";
import { rpc } from "./api";

type IntegrationsCatalogSnapshot = {
  catalog: ConnectionCatalogItem[];
  connections: Connection[];
};

export function listMcpServers(): Promise<McpServer[]> {
  return rpc("mcp/servers/list");
}

export function listCapabilities(): Promise<CapabilityInstall[]> {
  return rpc("capabilities/list");
}

export function listCapabilitySourcePresets(): Promise<McpSourcePreset[]> {
  return rpc("capabilities/sourcePresets");
}

export function listMarketplaceCatalog(): Promise<{
  entries: PluginMarketplaceEntry[];
  unavailableRegistries: string[];
}> {
  return rpc("marketplace/catalog", { query: "" });
}

export async function loadIntegrationsCatalogSnapshot(): Promise<IntegrationsCatalogSnapshot> {
  const catalog = await rpc("connections/catalog");
  const connections = await rpc("connections/list");
  return { catalog, connections };
}

export function listConnectionTools(input: { connectorId: string; provider: string }) {
  return rpc("connections/tools", input);
}

export function notifyOnboardingAppConnected(input: {
  botId: string;
  provider: string;
  connectorId: string;
}) {
  return rpc("onboarding/appConnected", input);
}

export function beginConnection(input: {
  connectorId: string;
  provider: string;
  displayName: string;
}) {
  return rpc("connections/begin", input);
}

export function completeConnection(input: { connectionId: string }) {
  return rpc("connections/complete", input);
}

export function revokeConnection(input: { connectionId: string }) {
  return rpc("connections/revoke", input);
}

export function renameConnection(input: { connectionId: string; displayName: string }) {
  return rpc("connections/rename", input);
}

export function setConnectionVerbatimResults(input: {
  connectionId: string;
  verbatimResults: boolean;
}) {
  return rpc("connections/setVerbatimResults", input);
}

export function beginMcpOAuth(input: { serverId: string }) {
  return rpc("mcp/oauth/begin", input);
}

export function createMcpServer(input: RpcInput<"mcp/servers/create">) {
  return rpc("mcp/servers/create", input);
}

export function installCapability(input: RpcInput<"capabilities/install">) {
  return rpc("capabilities/install", input);
}

export function removeCapability(input: { id: string }) {
  return rpc("capabilities/remove", input);
}
