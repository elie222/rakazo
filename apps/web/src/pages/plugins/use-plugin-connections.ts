import { useLingui } from "@lingui/react/macro";
import type {
  CapabilityInstall,
  Connection,
  ConnectionCatalogItem,
  McpSourcePreset,
} from "@rakazo/contracts";
import type { CatalogConnectionTarget } from "@rakazo/core";
import {
  catalogItemAccounts,
  catalogItemKey,
  catalogWithOrganizationConnections,
  connectCatalogItem,
  connectedAppMarks,
  connectionLabelFrom,
  isCatalogItemConnected,
} from "@rakazo/core";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import { bestEffort } from "@rakazo/logging/best-effort";
import { queryOptions, skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { optionalCatalogFeedProbe } from "../../lib/integrations/optional-catalog-feed";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { useSpaceRpc } from "../../lib/query/space-rpc";
import { errorText } from "../../lib/query/user-error";

const NO_CATALOG: ConnectionCatalogItem[] = [];
const NO_CONNECTIONS: Connection[] = [];
const NO_SOURCES: CapabilityInstall[] = [];
const NO_PRESETS: McpSourcePreset[] = [];

function markConnected(
  items: ConnectionCatalogItem[],
  connectorId: string,
  slug: string,
  connected: boolean,
) {
  return items.map((entry) =>
    entry.connectorId === connectorId && entry.slug === slug ? { ...entry, connected } : entry,
  );
}

export type PluginConnections = ReturnType<typeof usePluginConnections>;

/**
 * The integrations the overlay lists (apps, accounts, MCP servers, tool sources, plugins) and the
 * actions that connect, rename, revoke, and uninstall them. Every view reads the same state.
 */
export function usePluginConnections({
  activeBotId,
  detailKey,
  closeDetail,
  onConnectedAppsChange,
}: {
  activeBotId?: string;
  /** The app whose page is open; its tools load while it is. */
  detailKey: { connectorId: string; slug: string } | null;
  closeDetail: () => void;
  onConnectedAppsChange?: (apps: ReturnType<typeof connectedAppMarks>) => void;
}) {
  const { t } = useLingui();
  // Only accounts whose label is being edited; the rest follow the saved name.
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [sourcePending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const connectionAttempt = useRef<AbortController | null>(null);
  const queries = useSpaceQueries();
  const spaceRpc = useSpaceRpc();
  const queryClient = useQueryClient();
  const mcpOptions = queries.mcp.servers.list.queryOptions();
  const mcpQuery = useQuery(mcpOptions);
  const mcpServers = mcpQuery.data ?? [];
  const sourcePresets =
    useQuery(queries.capabilities.sourcePresets.queryOptions()).data ?? NO_PRESETS;
  const mcpError = mcpQuery.error ? errorText(mcpQuery.error, t`Could not load MCP servers`) : null;
  async function loadIntegrations() {
    // The catalog call reconciles connection rows, so list them after it settles.
    const catalog = spaceRpc.connections.catalog({});
    const [items, installs, rows, catalogFeed] = await Promise.all([
      catalog,
      spaceRpc.capabilities.list(),
      catalog.then(() => spaceRpc.connections.list()),
      optionalCatalogFeedProbe(spaceRpc.capabilities.catalogSearch({ query: "" })),
    ]);
    return {
      catalog: catalogWithOrganizationConnections(items, rows),
      connections: rows,
      sources: installs.filter(
        (install) => install.kind === "mcp" || install.kind === "api" || install.kind === "graphql",
      ),
      plugins: installs.filter((install) => install.kind === "plugin"),
      catalogFeedEnabled: catalogFeed.enabled,
    };
  }
  const integrationsOptions = queryOptions({
    queryKey: [...queries.connections.catalog.queryKey({ input: {} }), "integrations"],
    queryFn: loadIntegrations,
  });
  const integrations = useQuery(integrationsOptions);
  const catalogLoaded = integrations.data !== undefined;
  const loading = !catalogLoaded && integrations.isFetching;
  const catalog = integrations.data?.catalog ?? NO_CATALOG;
  const connections = integrations.data?.connections ?? NO_CONNECTIONS;
  const sources = integrations.data?.sources ?? NO_SOURCES;
  const pluginInstalls = integrations.data?.plugins ?? NO_SOURCES;
  const pluginCatalog = useQuery(
    queries.marketplace.catalog.queryOptions({ input: { query: "" }, staleTime: 60_000 }),
  );
  const assignmentsQuery = useQuery(
    queries.mcp.assignments.list.queryOptions({
      input: activeBotId ? { botId: activeBotId } : skipToken,
    }),
  );
  const assigned = useMemo(
    () => new Set((assignmentsQuery.data ?? []).map((row) => row.serverId)),
    [assignmentsQuery.data],
  );
  const catalogFeedEnabled = integrations.data?.catalogFeedEnabled ?? false;
  // A failed refresh is shown even over what was cached, so stale apps never pass as current.
  const loadError = integrations.error
    ? errorText(integrations.error, t`Could not load integrations`)
    : null;
  const toolsQuery = useQuery(
    queries.connections.tools.queryOptions({
      input: detailKey
        ? { connectorId: detailKey.connectorId, provider: detailKey.slug }
        : skipToken,
    }),
  );
  const tools = (detailKey && toolsQuery.data) || [];
  const toolsLoading = Boolean(detailKey) && toolsQuery.isLoading;
  const toolsFailed = Boolean(detailKey) && toolsQuery.isError;

  function updateIntegrations(
    update: (
      current: NonNullable<typeof integrations.data>,
    ) => NonNullable<typeof integrations.data>,
  ) {
    return writeSaved(queryClient, integrationsOptions.queryKey, (current) =>
      update(
        current ?? {
          catalog: NO_CATALOG,
          connections: NO_CONNECTIONS,
          sources: NO_SOURCES,
          plugins: NO_SOURCES,
          catalogFeedEnabled: false,
        },
      ),
    );
  }

  /** Reads integrations again with requests sent after a change. */
  async function refresh() {
    void fetchFresh(queryClient, mcpOptions).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: queries.mcp.assignments.key() });
    await fetchFresh(queryClient, {
      queryKey: integrationsOptions.queryKey,
      queryFn: loadIntegrations,
    });
  }

  useEffect(() => {
    return () => connectionAttempt.current?.abort();
  }, []);

  useEffect(() => {
    if (catalogLoaded) onConnectedAppsChange?.(connectedAppMarks(catalog, connections));
  }, [catalog, catalogLoaded, connections, onConnectedAppsChange]);

  function itemConnected(item: ConnectionCatalogItem) {
    return isCatalogItemConnected(connections, item);
  }

  const stale = [integrationsOptions.queryKey, queries.connections.tools.key()];
  const connectSave = useSave({
    save: async (
      { item, target }: { item: ConnectionCatalogItem; target: CatalogConnectionTarget },
      client,
    ) => {
      connectionAttempt.current?.abort();
      const controller = new AbortController();
      connectionAttempt.current = controller;
      try {
        const result = await connectCatalogItem(item, connections, {
          begin: (input) =>
            target === "me"
              ? client.connections.begin(input)
              : target === "organization"
                ? client.connections.beginForOrganization({
                    ...input,
                    displayName: connectionLabelFrom(item.name, item.slug),
                  })
                : client.connections.reconnectOrganization({ connectionId: target.reconnectId }),
          complete: (input) => client.connections.complete(input),
          openUrl: (url) => window.open(url, "rakazo-plugin-connect", "noopener,noreferrer"),
          signal: controller.signal,
        });
        if (result.status === "connected" && activeBotId)
          void bestEffort(
            "tell onboarding an app was connected",
            client.onboarding.appConnected({
              botId: activeBotId,
              provider: item.slug,
              connectorId: item.connectorId,
            }),
          );
        return result;
      } finally {
        if (connectionAttempt.current === controller) connectionAttempt.current = null;
      }
    },
    stale,
    onSaved: (result, { item }) => {
      if (result.status === "pending")
        setNotice(
          t`Connection to ${item.name} is still pending. You can close this and check again.`,
        );
    },
  });

  const revokeSave = useSave({
    save: (row: Connection, client) => client.connections.revoke({ connectionId: row.id }),
    stale,
  });
  const uninstallSave = useSave({
    save: async (item: ConnectionCatalogItem, client) => {
      const matches = catalogItemAccounts(connections, item).filter(
        (row) => row.manageable !== false,
      );
      for (const row of matches) await client.connections.revoke({ connectionId: row.id });
      if (!matches.length) {
        await updateIntegrations((current) => ({
          ...current,
          catalog: markConnected(current.catalog, item.connectorId, item.slug, false),
        }));
      }
    },
    stale,
    onSaved: closeDetail,
    onFailed: () => bestEffort("refresh app connections after a failed uninstall", refresh()),
  });
  const renameSave = useSave({
    save: ({ row, displayName }: { row: Connection; displayName: string }, client) =>
      client.connections.rename({ connectionId: row.id, displayName }),
    stale,
    onSaved: (row) => clearDraft(row.id),
  });
  const pending =
    sourcePending ??
    (connectSave.pending && connectSave.input
      ? catalogItemKey(connectSave.input.item)
      : revokeSave.pending && revokeSave.input
        ? revokeSave.input.id
        : renameSave.pending && renameSave.input
          ? `rename:${renameSave.input.row.id}`
          : uninstallSave.pending && uninstallSave.input
            ? `uninstall:${catalogItemKey(uninstallSave.input)}`
            : null);
  const catalogError =
    notice ??
    (connectSave.error
      ? errorText(connectSave.error, t`Could not connect`)
      : renameSave.error
        ? errorText(renameSave.error, t`Could not rename connection`)
        : revokeSave.error || uninstallSave.error
          ? errorText(revokeSave.error ?? uninstallSave.error, t`Could not revoke connection`)
          : null);
  function setCatalogError(message: string | null) {
    setNotice(message);
    connectSave.reset();
    revokeSave.reset();
    uninstallSave.reset();
    renameSave.reset();
  }
  function connect(item: ConnectionCatalogItem, target: CatalogConnectionTarget = "me") {
    setCatalogError(null);
    connectSave.run({ item, target });
  }
  function revokeAccount(row: Connection) {
    setCatalogError(null);
    revokeSave.run(row);
  }
  function uninstall(item: ConnectionCatalogItem) {
    setCatalogError(null);
    uninstallSave.run(item);
  }
  function clearDraft(id: string) {
    setLabelDrafts(({ [id]: _draft, ...rest }) => rest);
  }
  function renameAccount(row: Connection) {
    const displayName = (labelDrafts[row.id] ?? row.displayName).trim();
    if (!displayName || displayName === row.displayName) {
      clearDraft(row.id);
      return;
    }
    setCatalogError(null);
    renameSave.run({ row, displayName });
  }

  return {
    mcpQuery,
    mcpServers,
    sourcePresets,
    mcpError,
    integrations,
    catalogLoaded,
    loading,
    catalog,
    connections,
    sources,
    pluginInstalls,
    pluginCatalog,
    assigned,
    catalogFeedEnabled,
    loadError,
    tools,
    toolsLoading,
    toolsFailed,
    updateIntegrations,
    refresh,
    labelDrafts,
    setLabelDrafts,
    pending,
    setPending,
    catalogError,
    setCatalogError,
    itemConnected,
    connect,
    revokeAccount,
    uninstall,
    renameAccount,
  };
}
