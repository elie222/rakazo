import { useLingui } from "@lingui/react/macro";
import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import { catalogItemAccounts, catalogItemKey, connectCatalogItem } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import type { DataTag, QueryKey } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useRef } from "react";
import { Alert, Linking } from "react-native";
import { rpc } from "../../lib/api/api";
import { errorText } from "../../lib/api/user-error";
import { loadLastBotId } from "../../lib/inbox/last-bot";
import { signInToMcpServer } from "../../lib/integrations/mcp-oauth";
import { queryClient, useSave } from "../../lib/query/query";

type Read<T> = { queryKey: DataTag<QueryKey, T, Error> };

/**
 * The Integrations screen's account and server actions. Each one belongs to the Space it was
 * tapped in, marks itself pending, and reports its own failure; a success reads `stale` again.
 */
export function useConnectionActions({
  catalogRead,
  connectionsRead,
  stale,
  connections,
  labelDrafts,
  setLabelDrafts,
  lastBotId,
  setLastBotId,
  closeDetail,
}: {
  catalogRead: Read<ConnectionCatalogItem[]>;
  connectionsRead: Read<Connection[]>;
  stale: readonly QueryKey[];
  connections: Connection[];
  labelDrafts: Record<string, string>;
  setLabelDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  lastBotId: string;
  setLastBotId: (id: string) => void;
  closeDetail: () => void;
}) {
  const { t } = useLingui();
  const connectionAttempt = useRef<AbortController | null>(null);
  // Another app tapped while a connection is still waiting on the browser starts once it stops.
  const nextConnect = useRef<ConnectionCatalogItem | null>(null);

  /** Shows a changed account at once; a refresh sent before the change would answer without it. */
  async function updateAccount(row: Connection) {
    const rows = queryClient.getQueryData(connectionsRead.queryKey) ?? [];
    const items = queryClient.getQueryData(catalogRead.queryKey);
    await Promise.all([
      queryClient.cancelQueries({ queryKey: connectionsRead.queryKey }),
      queryClient.cancelQueries({ queryKey: catalogRead.queryKey }),
    ]);
    const next = [...rows.filter((entry) => entry.id !== row.id), row];
    queryClient.setQueryData(connectionsRead.queryKey, next);
    if (!items) return;
    queryClient.setQueryData(
      catalogRead.queryKey,
      items.map((item) =>
        item.connectorId === row.connectorId && item.slug === row.provider
          ? {
              ...item,
              connected: next.some(
                (entry) =>
                  entry.connectorId === item.connectorId &&
                  entry.provider === item.slug &&
                  entry.status === "connected",
              ),
            }
          : item,
      ),
    );
  }

  async function notifyAppConnected(item: ConnectionCatalogItem) {
    const botId = lastBotId || (await loadLastBotId());
    if (!botId) return;
    if (botId !== lastBotId) setLastBotId(botId);
    void bestEffort(
      "tell onboarding an app was connected",
      rpc("onboarding/appConnected", {
        botId,
        provider: item.slug,
        connectorId: item.connectorId,
      }),
    );
  }

  function startNextConnect() {
    const next = nextConnect.current;
    nextConnect.current = null;
    if (next) connect.run(next);
  }

  const connect = useSave({
    save: async (item: ConnectionCatalogItem, send) => {
      const controller = new AbortController();
      connectionAttempt.current = controller;
      try {
        const result = await connectCatalogItem(item, connections, {
          begin: (input) => send("connections/begin", input),
          complete: (input) => send("connections/complete", input),
          openUrl: (url) => Linking.openURL(url),
          signal: controller.signal,
        });
        if (result.status === "connected" && result.row) await updateAccount(result.row);
        return result.status;
      } catch (reason) {
        // Leaving the screen or starting another app stops this one without a failure to show.
        if (controller.signal.aborted) return "aborted" as const;
        throw reason;
      } finally {
        if (connectionAttempt.current === controller) connectionAttempt.current = null;
      }
    },
    stale,
    onSaved: (status, item) => {
      if (status === "connected") void notifyAppConnected(item);
      if (status === "pending")
        Alert.alert(
          t`Connection pending`,
          t`Finish connecting in the browser, then refresh this page.`,
        );
      startNextConnect();
    },
    onFailed: startNextConnect,
  });

  const revoke = useSave({
    save: async (row: Connection, send) => {
      await send("connections/revoke", { connectionId: row.id });
      await updateAccount({ ...row, status: "revoked" });
    },
    stale,
  });

  const rename = useSave({
    save: async ({ row, displayName }: { row: Connection; displayName: string }, send) => {
      const updated = await send("connections/rename", { connectionId: row.id, displayName });
      await updateAccount(updated);
      return updated;
    },
    onSaved: (updated) =>
      setLabelDrafts((current) => ({ ...current, [updated.id]: updated.displayName })),
  });

  const uninstall = useSave({
    save: async (item: ConnectionCatalogItem, send) => {
      for (const row of catalogItemAccounts(connections, item)) {
        await send("connections/revoke", { connectionId: row.id });
        await updateAccount({ ...row, status: "revoked" });
      }
    },
    stale,
    onSaved: closeDetail,
    // Some accounts may be gone already, so the screen reads them again.
    onFailed: () => {
      for (const queryKey of stale) void queryClient.invalidateQueries({ queryKey });
    },
  });

  const authorize = useSave({
    save: (serverId: string, send) => signInToMcpServer(send, serverId),
    stale,
  });

  /** Stops a connection still waiting on the browser, as when the screen loses focus. */
  const stopConnecting = useCallback(() => connectionAttempt.current?.abort(), []);

  const pending = connect.pending
    ? connect.input && catalogItemKey(connect.input)
    : revoke.pending
      ? revoke.input?.id
      : rename.pending
        ? `rename:${rename.input?.row.id}`
        : uninstall.pending
          ? uninstall.input && `uninstall:${catalogItemKey(uninstall.input)}`
          : authorize.pending
            ? `oauth:${authorize.input}`
            : null;

  /** The last account action's failure, worded for what was tried. */
  const failure = connect.error
    ? errorText(connect.error, t`Could not connect`)
    : rename.error
      ? errorText(rename.error, t`Could not rename connection`)
      : (revoke.error ?? uninstall.error)
        ? errorText(revoke.error ?? uninstall.error, t`Could not revoke connection`)
        : null;

  return {
    connect(item: ConnectionCatalogItem) {
      if (!connect.pending) return connect.run(item);
      if (connect.input && catalogItemKey(connect.input) === catalogItemKey(item)) return;
      nextConnect.current = item;
      connectionAttempt.current?.abort();
    },
    revokeAccount: (row: Connection) => revoke.run(row),
    renameAccount(row: Connection) {
      const displayName = (labelDrafts[row.id] ?? row.displayName).trim();
      if (!displayName || displayName === row.displayName) return;
      rename.run({ row, displayName });
    },
    uninstall(item: ConnectionCatalogItem) {
      if (catalogItemAccounts(connections, item).length === 0) return closeDetail();
      uninstall.run(item);
    },
    authorizeMcp: (serverId: string) => authorize.run(serverId),
    stopConnecting,
    /** Forgets the account failures shown, as a retry or a newly opened app does. */
    resetFailures() {
      connect.reset();
      revoke.reset();
      rename.reset();
      uninstall.reset();
    },
    pending: pending ?? null,
    failure,
    mcpFailure: authorize.error ? errorText(authorize.error, t`Could not start MCP OAuth`) : null,
    resetMcpFailure: authorize.reset,
  };
}
