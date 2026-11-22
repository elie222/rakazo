import { useLingui } from "@lingui/react/macro";
import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import { catalogItemAccounts, catalogItemKey, connectCatalogItem } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { Alert, Linking } from "react-native";
import { rpc } from "../../lib/api/api";
import { errorText } from "../../lib/api/user-error";
import { loadLastBotId } from "../../lib/inbox/last-bot";
import { signInToMcpServer } from "../../lib/integrations/mcp-oauth";

/**
 * The Integrations screen's account and server actions. Each one runs only while the screen's
 * scope it started in is still current, marks itself pending, and reports its failure.
 */
export function useConnectionActions({
  connections,
  labelDrafts,
  setLabelDrafts,
  lastBotId,
  setLastBotId,
  connectionAttempt,
  captureConnectionScope,
  updateAccount,
  refresh,
  retryRefresh,
  setPending,
  setCatalogError,
  setMcpError,
  onToolsChanged,
  closeDetail,
}: {
  connections: Connection[];
  labelDrafts: Record<string, string>;
  setLabelDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  lastBotId: string;
  setLastBotId: (id: string) => void;
  connectionAttempt: RefObject<AbortController | null>;
  captureConnectionScope: () => () => boolean;
  updateAccount: (row: Connection) => void;
  refresh: () => Promise<void>;
  retryRefresh: (isCurrent?: () => boolean) => Promise<void>;
  setPending: (pending: string | null) => void;
  setCatalogError: (error: string | null) => void;
  setMcpError: (error: string | null) => void;
  onToolsChanged: () => void;
  closeDetail: () => void;
}) {
  const { t } = useLingui();

  async function notifyAppConnected(item: ConnectionCatalogItem, isCurrent: () => boolean) {
    const botId = lastBotId || (await loadLastBotId());
    if (!botId || !isCurrent()) return;
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

  async function connect(item: ConnectionCatalogItem) {
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    const key = catalogItemKey(item);
    setPending(key);
    setCatalogError(null);
    try {
      const result = await connectCatalogItem(item, connections, {
        begin: (input) => rpc("connections/begin", input),
        complete: (input) => rpc("connections/complete", input),
        openUrl: (url) => Linking.openURL(url),
        signal: controller.signal,
        isCurrent,
      });
      if (result.status === "aborted") return;
      if (result.status === "connected") {
        if (result.row) updateAccount(result.row);
        void notifyAppConnected(item, isCurrent);
        await retryRefresh(isCurrent);
        if (isCurrent()) onToolsChanged();
        return;
      }
      Alert.alert(
        t`Connection pending`,
        t`Finish connecting in the browser, then refresh this page.`,
      );
    } catch (reason) {
      if (controller.signal.aborted || !isCurrent()) return;
      setCatalogError(errorText(reason, t`Could not connect`));
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        if (isCurrent()) setPending(null);
      }
    }
  }

  async function revokeAccount(row: Connection) {
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    setPending(row.id);
    setCatalogError(null);
    try {
      await rpc("connections/revoke", { connectionId: row.id });
      if (!isCurrent()) return;
      updateAccount({ ...row, status: "revoked" });
      await retryRefresh(isCurrent);
      if (isCurrent()) onToolsChanged();
    } catch (reason) {
      if (!isCurrent()) return;
      setCatalogError(errorText(reason, t`Could not revoke connection`));
    } finally {
      if (isCurrent()) setPending(null);
    }
  }

  async function renameAccount(row: Connection) {
    const displayName = (labelDrafts[row.id] ?? row.displayName).trim();
    if (!displayName || displayName === row.displayName) return;
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    setPending(`rename:${row.id}`);
    setCatalogError(null);
    try {
      const updated = await rpc("connections/rename", {
        connectionId: row.id,
        displayName,
      });
      if (!isCurrent()) return;
      updateAccount(updated);
      setLabelDrafts((current) => ({ ...current, [row.id]: updated.displayName }));
    } catch (reason) {
      if (!isCurrent()) return;
      setCatalogError(errorText(reason, t`Could not rename connection`));
    } finally {
      if (isCurrent()) setPending(null);
    }
  }

  async function uninstall(item: ConnectionCatalogItem) {
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    const matches = catalogItemAccounts(connections, item);
    const key = catalogItemKey(item);
    if (matches.length === 0) {
      closeDetail();
      return;
    }
    setPending(`uninstall:${key}`);
    setCatalogError(null);
    try {
      for (const row of matches) {
        await rpc("connections/revoke", { connectionId: row.id });
        if (!isCurrent()) return;
        updateAccount({ ...row, status: "revoked" });
      }
      await retryRefresh(isCurrent);
      if (isCurrent()) closeDetail();
    } catch (reason) {
      if (!isCurrent()) return;
      await bestEffort("refresh integrations after a failed uninstall", refresh());
      if (isCurrent()) setCatalogError(errorText(reason, t`Could not revoke connection`));
    } finally {
      if (isCurrent()) setPending(null);
    }
  }

  async function authorizeMcp(serverId: string) {
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    setPending(`oauth:${serverId}`);
    setMcpError(null);
    try {
      await signInToMcpServer(rpc, serverId);
      if (isCurrent()) await retryRefresh(isCurrent);
    } catch (reason) {
      if (isCurrent()) setMcpError(errorText(reason, t`Could not start MCP OAuth`));
    } finally {
      if (isCurrent()) setPending(null);
    }
  }

  return { connect, revokeAccount, renameAccount, uninstall, authorizeMcp };
}
