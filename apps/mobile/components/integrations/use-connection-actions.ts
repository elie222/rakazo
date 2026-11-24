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
import { captureSessionScope } from "../../lib/api/verified-scope";
import { loadLastBotId } from "../../lib/inbox/last-bot";
import { signInToMcpServer } from "../../lib/integrations/mcp-oauth";
import { queryClient, useSave } from "../../lib/query/query";

type Read<T> = { queryKey: DataTag<QueryKey, T, Error> };

/** A connection stopped before it finished; nothing to report and nothing to read again. */
class ConnectStopped extends Error {}

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
  captureFocus,
}: {
  catalogRead: Read<ConnectionCatalogItem[]>;
  connectionsRead: Read<Connection[]>;
  stale: readonly QueryKey[];
  connections: Connection[];
  labelDrafts: Record<string, string>;
  setLabelDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  lastBotId: string;
  setLastBotId: (id: string) => void;
  /** Closes the open app, or only `item` when it is still the one open. */
  closeDetail: (item?: ConnectionCatalogItem) => void;
  /** Whether the screen keeps the focus it has now, as the screen counts its visits. */
  captureFocus: () => () => boolean;
}) {
  const { t } = useLingui();
  const connectionAttempt = useRef<AbortController | null>(null);
  // Another app tapped while a connection is still waiting on the browser starts once that one
  // stops, if the screen still shows the Space and session it was tapped in.
  const nextConnect = useRef<{ item: ConnectionCatalogItem; isCurrent: () => boolean } | null>(
    null,
  );

  /** Shows a changed account at once; a refresh sent before the change would answer without it. */
  async function updateAccount(row: Connection) {
    await Promise.all([
      queryClient.cancelQueries({ queryKey: connectionsRead.queryKey }),
      queryClient.cancelQueries({ queryKey: catalogRead.queryKey }),
    ]);
    // Built on what is cached now, so another action that finished meanwhile is kept.
    const next = queryClient.setQueryData(connectionsRead.queryKey, (rows = []) => [
      ...rows.filter((entry) => entry.id !== row.id),
      row,
    ]) ?? [row];
    queryClient.setQueryData(catalogRead.queryKey, (items) =>
      items?.map((item) =>
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

  async function notifyAppConnected(item: ConnectionCatalogItem, focused: () => boolean) {
    const isCurrent = captureSessionScope();
    const botId = lastBotId || (await loadLastBotId());
    if (!botId || !isCurrent() || !focused()) return;
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
    if (next?.isCurrent()) connect.run(next.item);
  }

  const connect = useSave({
    save: async (item: ConnectionCatalogItem, send) => {
      // One attempt at a time: one started in another Space stops the earlier one.
      connectionAttempt.current?.abort();
      const focused = captureFocus();
      const controller = new AbortController();
      connectionAttempt.current = controller;
      try {
        const result = await connectCatalogItem(item, connections, {
          begin: (input) => send("connections/begin", input),
          complete: (input) => send("connections/complete", input),
          openUrl: (url) => Linking.openURL(url),
          signal: controller.signal,
          isCurrent: captureSessionScope(),
        });
        // Stopped (left, another app tapped, another Space): a failure that shows nothing and
        // reads nothing again, so a queued app starts at once.
        if (result.status === "aborted") throw new ConnectStopped();
        if (result.status === "connected" && result.row) await updateAccount(result.row);
        return { status: result.status, focused };
      } catch (reason) {
        if (controller.signal.aborted) throw new ConnectStopped();
        throw reason;
      } finally {
        if (connectionAttempt.current === controller) connectionAttempt.current = null;
      }
    },
    stale,
    onSaved: ({ status, focused }, item) => {
      if (status === "connected") void notifyAppConnected(item, focused);
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
    stale,
    onSaved: (updated) =>
      setLabelDrafts((current) => ({ ...current, [updated.id]: updated.displayName })),
  });

  const uninstall = useSave({
    // Each account revoked shows as revoked at once, so a failure part way leaves the screen
    // showing what the server holds without reading the lists again.
    save: async (item: ConnectionCatalogItem, send) => {
      const focused = captureFocus();
      for (const row of catalogItemAccounts(connections, item)) {
        await send("connections/revoke", { connectionId: row.id });
        await updateAccount({ ...row, status: "revoked" });
      }
      return focused;
    },
    stale,
    // Closes the app it removed, and only on the visit it was removed in.
    onSaved: (focused, item) => {
      if (focused()) closeDetail(item);
    },
  });

  const authorize = useSave({
    save: (serverId: string, send) => signInToMcpServer(send, serverId),
    stale,
  });

  /** Stops a connection still waiting on the browser, as when the screen loses focus. */
  const stopConnecting = useCallback(() => {
    nextConnect.current = null;
    connectionAttempt.current?.abort();
  }, []);

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
  const failure =
    connect.error && !(connect.error instanceof ConnectStopped)
      ? errorText(connect.error, t`Could not connect`)
      : rename.error
        ? errorText(rename.error, t`Could not rename connection`)
        : (revoke.error ?? uninstall.error)
          ? errorText(revoke.error ?? uninstall.error, t`Could not revoke connection`)
          : null;

  /** Forgets the account failures shown: one slot, as a retry, an opened app or a new action does. */
  function resetFailures() {
    connect.reset();
    revoke.reset();
    rename.reset();
    uninstall.reset();
  }

  return {
    connect(item: ConnectionCatalogItem) {
      if (!connect.pending) {
        resetFailures();
        return connect.run(item);
      }
      if (connect.input && catalogItemKey(connect.input) === catalogItemKey(item)) return;
      nextConnect.current = { item, isCurrent: captureSessionScope() };
      connectionAttempt.current?.abort();
    },
    revokeAccount(row: Connection) {
      resetFailures();
      revoke.run(row);
    },
    renameAccount(row: Connection) {
      const displayName = (labelDrafts[row.id] ?? row.displayName).trim();
      if (!displayName || displayName === row.displayName) return;
      resetFailures();
      rename.run({ row, displayName });
    },
    uninstall(item: ConnectionCatalogItem) {
      if (catalogItemAccounts(connections, item).length === 0) return closeDetail(item);
      resetFailures();
      uninstall.run(item);
    },
    /** A new attempt, or Retry, is what clears a failed sign-in. */
    authorizeMcp: (serverId: string) => authorize.run(serverId),
    stopConnecting,
    resetFailures,
    pending: pending ?? null,
    failure,
    mcpFailure: authorize.error ? errorText(authorize.error, t`Could not start MCP OAuth`) : null,
    resetMcpFailure: authorize.reset,
  };
}
