import type { SignInMcpServer } from "@rakazo/core";
import { signInMcpServers } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { finishMcpSignIn } from "../lib/mcp-oauth";
import { native, useThemedStyles } from "../lib/native";
import { errorText } from "../lib/user-error";
import { ConnectorIcon } from "./connector-icon";
import { LOGO_SIZE } from "./integrations-styles";
import { NativeActionButton } from "./native-action-button";

/** Looks the search up in the public app catalog when asked, and connects a server by signing in. */
export function IntegrationCatalogSearch({
  query,
  onConnected,
  onSearched,
}: {
  query: string;
  /** Called with the server that was added, whether or not its sign-in finished. */
  onConnected: (serverId: string) => Promise<void>;
  onSearched: (searched: boolean) => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [servers, setServers] = useState<SignInMcpServer[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trimmed = query.trim();
  const latestQuery = useRef(trimmed);
  latestQuery.current = trimmed;

  useEffect(() => {
    setServers(null);
    setError(null);
  }, [trimmed]);

  useEffect(() => {
    onSearched(servers !== null);
    return () => onSearched(false);
  }, [servers, onSearched]);

  if (!trimmed) return null;

  async function search() {
    const sent = trimmed;
    setPending("search");
    setError(null);
    try {
      const response = await rpc("capabilities/catalogSearch", {
        query: sent,
        usePublicCatalog: true,
      });
      if (latestQuery.current === sent) setServers(signInMcpServers(response.results));
    } catch (reason) {
      if (latestQuery.current === sent) setError(errorText(reason, t("Could not connect")));
    } finally {
      setPending(null);
    }
  }

  async function connect(server: SignInMcpServer) {
    setPending(server.endpoint);
    setError(null);
    try {
      const { server: row, signIn } = await rpc("mcp/servers/connect", {
        ...server,
        client: "mobile",
      });
      try {
        await finishMcpSignIn(signIn);
      } finally {
        // The server is added whether or not sign-in finishes; show it, with any client it needs.
        await onConnected(row.id).catch(() => undefined);
      }
    } catch (reason) {
      setError(errorText(reason, t("Could not connect")));
    } finally {
      setPending(null);
    }
  }

  return (
    <View testID="integration-catalog-search" style={styles.stack}>
      {servers === null ? (
        <NativeActionButton
          fill={false}
          label={t("Search more apps")}
          busy={pending === "search"}
          disabled={Boolean(pending)}
          onPress={() => void search()}
          prominence="secondary"
        />
      ) : servers.length === 0 ? (
        <Text style={styles.secondary}>{t("No apps match your search.")}</Text>
      ) : (
        servers.map((server) => (
          <View key={server.endpoint} style={styles.row}>
            <ConnectorIcon name={server.name} size={LOGO_SIZE} />
            <Text numberOfLines={1} style={styles.title}>
              {server.name}
            </Text>
            <NativeActionButton
              fill={false}
              label={t("Sign in")}
              accessibilityLabel={t("Connect MCP server {name}", {
                name: server.name,
              })}
              busy={pending === server.endpoint}
              disabled={Boolean(pending)}
              onPress={() => void connect(server)}
              prominence="secondary"
            />
          </View>
        ))
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    stack: { gap: 8 },
    row: {
      minHeight: 56,
      paddingHorizontal: 12,
      paddingVertical: 12,
      borderRadius: 14,
      backgroundColor: native.fill,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    title: {
      flex: 1,
      minWidth: 0,
      color: native.label,
      fontSize: 15,
      fontWeight: "600",
    },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
    error: { color: mobileTokens().destructive, fontSize: 14 },
  });
}
