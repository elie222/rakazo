import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { SignInMcpServer } from "@rakazo/core";
import { signInMcpServers } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { finishMcpSignIn } from "../../lib/integrations/mcp-oauth";
import { useThemedStyles } from "../../lib/native/native";
import { queryClient, rpcQuery, useSave } from "../../lib/query/query";
import { NativeActionButton } from "../native/native-action-button";
import { ConnectorIcon } from "./connector-icon";
import { createIntegrationsStyles, LOGO_SIZE } from "./integrations-styles";

/** Looks the search up in the public app catalog when asked, and connects a server by signing in. */
export function IntegrationCatalogSearch({
  query,
  hidden,
  noLocalMatch,
  onChanged,
}: {
  query: string;
  /** Kept mounted while hidden so a connect still in flight reports back when it finishes. */
  hidden: boolean;
  /** Nothing on the screen matched, so say so unless the catalog finds something. */
  noLocalMatch: boolean;
  /** A server was added or signed in to, whether or not its sign-in finished. */
  onChanged: (serverId?: string) => unknown;
}) {
  const { t } = useLingui();
  const styles = useThemedStyles(createIntegrationsStyles);
  const trimmed = query.trim();
  const [asked, setAsked] = useState<string | null>(null);
  const searching = Boolean(trimmed) && asked === trimmed;
  const search = useQuery(
    {
      ...rpcQuery("capabilities/catalogSearch", { query: trimmed, usePublicCatalog: true }),
      enabled: searching,
      staleTime: Number.POSITIVE_INFINITY,
    },
    queryClient,
  );
  // The server is added before its sign-in, so a failed sign-in can still be retried on it.
  const addedIds = useRef(new Map<string, string>());
  const connect = useSave({
    save: async (server: SignInMcpServer, send) => {
      const { server: added, signIn } = await send("mcp/servers/connect", {
        ...server,
        client: "mobile",
      });
      addedIds.current.set(server.endpoint, added.id);
      await finishMcpSignIn(send, signIn);
      return added.id;
    },
    onSaved: (serverId) => onChanged(serverId),
    onFailed: (_error, server) => onChanged(addedIds.current.get(server.endpoint)),
  });
  if (!trimmed || hidden) return null;
  const servers = searching && search.data ? signInMcpServers(search.data.results) : null;
  const failure = connect.error ?? (searching ? search.error : null);
  return (
    <View testID="integration-catalog-search" style={styles.catalogStack}>
      {noLocalMatch && !servers?.length ? (
        <Text style={styles.secondary}>{t`No apps match your search.`}</Text>
      ) : null}
      {servers === null ? (
        <NativeActionButton
          fill={false}
          label={t`Search more apps`}
          busy={searching && search.isFetching}
          onPress={() => (searching ? void search.refetch() : setAsked(trimmed))}
          prominence="secondary"
        />
      ) : (
        servers.map((server) => (
          <View key={server.endpoint} style={styles.row}>
            <ConnectorIcon name={server.name} size={LOGO_SIZE} />
            <Text numberOfLines={1} style={[styles.title, styles.grow]}>
              {server.name}
            </Text>
            <NativeActionButton
              fill={false}
              label={t`Connect`}
              accessibilityLabel={t`Connect ${ph({ name: server.name })}`}
              busy={connect.pending && connect.input?.endpoint === server.endpoint}
              disabled={connect.pending}
              onPress={() => connect.run(server)}
              prominence="secondary"
            />
          </View>
        ))
      )}
      {failure ? (
        <Text style={styles.error}>{errorText(failure, t`Could not connect`)}</Text>
      ) : null}
    </View>
  );
}
