import type { Connection, ConnectionCatalogItem, MessageBlock } from "@rakazo/contracts";
import { connectionLabelFrom } from "./connection-catalog.js";
import { featuredConnectorProvidersMatch } from "./featured-connectors.js";

export type AppConnectBlock = Extract<MessageBlock, { kind: "app_connect" }>;

const APP_DESCRIPTIONS: Record<string, string> = {
  slack: "Search, read, and send messages.",
  gmail: "Search, read, draft, and send email.",
  googlecalendar: "Search events and schedule meetings.",
  notion: "Search and edit pages and databases.",
  googledocs: "Draft and edit documents.",
  hackernews: "Search stories and discussions.",
};

export function matchAppCatalog(catalog: ConnectionCatalogItem[], app: string) {
  const query = app.trim().toLowerCase();
  return (
    catalog.find(
      (entry) => entry.slug.toLowerCase() === query || entry.name.toLowerCase() === query,
    ) ?? catalog.find((entry) => featuredConnectorProvidersMatch(entry.slug, query))
  );
}

/** Like `matchAppCatalog`, but an entry some provider reports connected wins. */
export function matchConnectedAppCatalog(catalog: ConnectionCatalogItem[], app: string) {
  return (
    matchAppCatalog(
      catalog.filter((entry) => entry.connected),
      app,
    ) ?? matchAppCatalog(catalog, app)
  );
}

export function appConnectCard(entry: ConnectionCatalogItem): AppConnectBlock {
  const description =
    Object.entries(APP_DESCRIPTIONS).find(
      ([slug]) =>
        entry.slug.toLowerCase() === slug || featuredConnectorProvidersMatch(entry.slug, slug),
    )?.[1] ?? "";
  return {
    kind: "app_connect",
    connectorId: entry.connectorId,
    provider: entry.slug,
    name: entry.name,
    description,
    logo: entry.logo ?? null,
    status: entry.connected ? "connected" : "pending",
  };
}

/** `defaultConnectorId` is the connector a card that names none belongs to. */
export function matchesAppConnection(
  block: MessageBlock,
  connectorId: string,
  provider: string,
  defaultConnectorId: string,
): block is AppConnectBlock {
  return (
    block.kind === "app_connect" &&
    (block.connectorId ?? defaultConnectorId) === connectorId &&
    (block.provider.toLowerCase() === provider.toLowerCase() ||
      featuredConnectorProvidersMatch(block.provider, provider))
  );
}

/** The block as connecting the app leaves it: the same block unless it is that app's open card. */
export function connectedAppBlock(
  block: MessageBlock,
  connectorId: string,
  provider: string,
  defaultConnectorId: string,
): MessageBlock {
  return matchesAppConnection(block, connectorId, provider, defaultConnectorId) &&
    block.status !== "connected"
    ? { ...block, status: "connected" }
    : block;
}

/** Shared completion input for inline cards on every client. */
export function appConnectedInput(
  botId: string,
  threadId: string,
  block: AppConnectBlock,
  messageId?: string,
) {
  return {
    botId,
    threadId,
    ...(messageId ? { messageId } : {}),
    ...(block.organizationConnectionId
      ? { organizationConnectionId: block.organizationConnectionId }
      : {}),
    connectorId: block.connectorId,
    provider: block.provider,
  };
}

/** What an app card sends as the new connection's name: its catalog name, kept to a valid label. */
export function appConnectLabel(block: AppConnectBlock) {
  return connectionLabelFrom(block.name, block.provider);
}

export function appConnectState(
  block: AppConnectBlock,
  connections: Connection[] | undefined,
  localStatus: AppConnectBlock["status"],
) {
  const shared = connections?.find((row) => row.id === block.organizationConnectionId);
  return {
    canAuthorize: !block.organizationConnectionId || shared?.manageable === true,
    status:
      block.status === "connected" || shared?.status === "connected" ? "connected" : localStatus,
  } as const;
}

export function appConnectRequest(block: AppConnectBlock) {
  return block.organizationConnectionId
    ? {
        procedure: "connections/reconnectOrganization" as const,
        input: { connectionId: block.organizationConnectionId },
      }
    : {
        procedure: "connections/begin" as const,
        input: {
          connectorId: block.connectorId,
          provider: block.provider,
          displayName: appConnectLabel(block),
        },
      };
}
