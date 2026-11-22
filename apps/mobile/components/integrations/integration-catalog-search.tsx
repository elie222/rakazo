import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { CATALOG_SEARCH_QUERY_MAX_LENGTH } from "@rakazo/contracts";
import type { CatalogMcpServer, SignInMcpServer } from "@rakazo/core";
import { catalogMcpServers } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { finishMcpSignIn } from "../../lib/integrations/mcp-oauth";
import { announceToScreenReader } from "../../lib/native/announce";
import { useThemedStyles } from "../../lib/native/native";
import { queryClient, rpcQuery, useSave } from "../../lib/query/query";
import { NativeActionButton } from "../native/native-action-button";
import { ConnectorIcon } from "./connector-icon";
import { createIntegrationsStyles, LOGO_SIZE } from "./integrations-styles";

/** Shows direct connections from the public catalog alongside local search results. */
export function IntegrationCatalogSearch({
  query,
  hidden,
  noLocalMatch,
  onChanged,
  onOpenMcp,
  excludedNames = [],
}: {
  query: string;
  /** Kept mounted while hidden so a connect still in flight reports back when it finishes. */
  hidden: boolean;
  /** Nothing on the screen matched, so say so unless the catalog finds something. */
  noLocalMatch: boolean;
  /** A server was added or signed in to, whether or not its sign-in finished. */
  onChanged: (serverId?: string) => unknown;
  onOpenMcp: (server: CatalogMcpServer) => void;
  excludedNames?: readonly string[];
}) {
  const { t } = useLingui();
  const styles = useThemedStyles(createIntegrationsStyles);
  const trimmed = query.trim();
  const eligible = trimmed.length >= 2 && trimmed.length <= CATALOG_SEARCH_QUERY_MAX_LENGTH;
  const [asked, setAsked] = useState<string | null>(null);
  const searching = eligible && asked === trimmed;
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
    // Each failed Connect is read out, in the same text the screen shows below.
    onFailed: (error, server) => {
      announceToScreenReader(errorText(error, t`Could not connect`));
      onChanged(addedIds.current.get(server.endpoint));
    },
  });
  // react-query has no per-query error callback, so a failed search is read out here, once per failure.
  const announcedSearchError = useRef<Error | null>(null);
  useEffect(() => {
    if (!searching || !search.error || search.error === announcedSearchError.current) return;
    announcedSearchError.current = search.error;
    announceToScreenReader(errorText(search.error, t`Could not connect`));
  }, [searching, search.error, t]);
  if (!trimmed || hidden) return null;
  const servers =
    searching && search.data
      ? catalogMcpServers(search.data.results).filter(
          ({ name }) => !excludedNames.includes(name.toLowerCase()),
        )
      : [];
  const failure = connect.error ?? (searching ? search.error : null);
  return (
    <View testID="integration-catalog-search" style={styles.catalogStack}>
      {noLocalMatch && !servers.length && (!searching || search.isSuccess) ? (
        <Text style={styles.secondary}>{t`No apps match your search.`}</Text>
      ) : null}
      {eligible && (!searching || !search.data) ? (
        <NativeActionButton
          fill={false}
          label={t`Search more apps`}
          busy={searching && search.isFetching}
          onPress={() => (searching ? void search.refetch() : setAsked(trimmed))}
          prominence="secondary"
        />
      ) : null}
      {servers.map((server) => (
        <View key={server.source} style={styles.row}>
          <ConnectorIcon name={server.name} size={LOGO_SIZE} />
          <Text numberOfLines={1} style={[styles.title, styles.grow]}>
            {server.name}
          </Text>
          <NativeActionButton
            fill={false}
            label={t`Connect`}
            accessibilityLabel={t`Connect ${ph({ name: server.name })}`}
            busy={connect.pending && connect.input?.endpoint === server.source}
            disabled={connect.pending}
            onPress={() => {
              if (server.auth && server.auth.type !== "oauth") onOpenMcp(server);
              else connect.run({ name: server.name, endpoint: server.source });
            }}
            prominence="secondary"
          />
        </View>
      ))}
      {failure ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorText(failure, t`Could not connect`)}
        </Text>
      ) : null}
    </View>
  );
}
