import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { CapabilityInstall, McpServer } from "@rakazo/contracts";
import { mcpServerConnection, mcpServerNeedsSignIn } from "@rakazo/contracts";
import { mcpServerStatusLabel } from "@rakazo/i18n/plugin-catalog";
import { Pressable, Text, View } from "react-native";
import { mobileTokens } from "../../lib/appearance/appearance";
import type { PluginParams } from "../../lib/integrations/plugin-marketplace";
import { native, useThemedStyles } from "../../lib/native/native";
import { NativeActionButton } from "../native/native-action-button";
import { NativeSymbol } from "../native/native-symbol";
import { ConnectorIcon } from "./connector-icon";
import { createIntegrationsStyles, LOGO_SIZE } from "./integrations-styles";
import { PluginIcon } from "./plugin-icon";

function InstalledPluginRow({
  params,
  summary,
  signIn,
  onOpenPlugin,
}: {
  params: PluginParams;
  summary: string;
  signIn: boolean;
  onOpenPlugin: (params: PluginParams) => void;
}) {
  const styles = useThemedStyles(createIntegrationsStyles);
  const { t } = useLingui();
  return (
    <Pressable
      testID="installed-plugin"
      accessibilityRole="button"
      accessibilityLabel={params.name}
      onPress={() => onOpenPlugin(params)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <PluginIcon logo={params.logo} name={params.name} site={params.site} size={LOGO_SIZE} />
      <View style={styles.grow}>
        <Text numberOfLines={1} style={styles.title}>
          {params.name}
        </Text>
        <Text numberOfLines={1} style={styles.secondary}>
          {summary}
        </Text>
      </View>
      {signIn ? (
        <NativeActionButton
          fill={false}
          label={t`Sign in`}
          onPress={() => onOpenPlugin(params)}
          prominence="secondary"
        />
      ) : null}
    </Pressable>
  );
}

/** A saved MCP server, how its connection stands, and its sign-in when it needs one. */
export function SavedServerRow({
  server,
  pending,
  oauthServerId,
  onAuthorize,
}: {
  server: McpServer;
  pending: string | null;
  /** A server just added to sign in to, offered Connect before it has ever been signed in. */
  oauthServerId: string | null;
  onAuthorize: (serverId: string) => void;
}) {
  const styles = useThemedStyles(createIntegrationsStyles);
  const { t } = useLingui();
  const state = mcpServerConnection(server);
  const tokens = mobileTokens();
  const warning = state === "needs_sign_in" || state === "needs_client";
  const color =
    state === "connected"
      ? tokens.success
      : warning
        ? tokens.warning
        : state === "not_working"
          ? tokens.destructive
          : native.secondaryLabel;
  const symbol =
    state === "connected"
      ? { ios: "checkmark", android: "checkmark" as const }
      : warning
        ? { ios: "exclamationmark.triangle", android: "warning-outline" as const }
        : state === "not_working"
          ? { ios: "exclamationmark.circle", android: "alert-circle-outline" as const }
          : null;
  return (
    <View testID="registered-mcp-server" style={styles.row}>
      <ConnectorIcon name={server.name} size={LOGO_SIZE} />
      <Text numberOfLines={1} style={[styles.title, styles.grow]}>
        {server.name}
      </Text>
      <View style={styles.connectionStatus}>
        {symbol ? (
          <View
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <NativeSymbol {...symbol} size={14} color={color} />
          </View>
        ) : null}
        <Text style={[styles.secondary, { color }]}>{mcpServerStatusLabel(state)}</Text>
      </View>
      {server.enabled &&
      state !== "connected" &&
      state !== "needs_client" &&
      (server.oauthStatus === "reconnect" || server.id === oauthServerId) ? (
        <NativeActionButton
          label={server.oauthStatus === "reconnect" ? t`Reconnect` : t`Connect`}
          fill={false}
          busy={pending === `oauth:${server.id}`}
          onPress={() => onAuthorize(server.id)}
          prominence="secondary"
        />
      ) : null}
    </View>
  );
}

/** What this account already has: plugins with a connector, saved servers, then custom sources. */
export function ConnectedApps({
  connectorPlugins,
  mcpServers,
  standaloneServers,
  sources,
  mcpError,
  pending,
  oauthServerId,
  pluginParamsFor,
  onOpenPlugin,
  onAuthorize,
  onRetry,
  onRemoveSource,
}: {
  connectorPlugins: CapabilityInstall[];
  mcpServers: McpServer[];
  /** Servers no plugin installed. */
  standaloneServers: McpServer[];
  sources: CapabilityInstall[];
  mcpError: string | null;
  pending: string | null;
  oauthServerId: string | null;
  pluginParamsFor: (install: CapabilityInstall) => PluginParams;
  onOpenPlugin: (params: PluginParams) => void;
  onAuthorize: (serverId: string) => void;
  onRetry: () => void;
  onRemoveSource: (source: CapabilityInstall) => void;
}) {
  const styles = useThemedStyles(createIntegrationsStyles);
  const { t } = useLingui();
  const apps = connectorPlugins.length + standaloneServers.length + sources.length;
  if (!apps && !mcpError) return null;
  return (
    <View testID="connected-apps" style={styles.catalogStack}>
      <Text style={styles.section}>{t`Apps`}</Text>
      {mcpError ? (
        <View>
          <Text style={styles.error}>{mcpError}</Text>
          <NativeActionButton
            label={t`Retry`}
            fill={false}
            onPress={onRetry}
            prominence="secondary"
          />
        </View>
      ) : null}
      {connectorPlugins.map((install) => {
        const servers = mcpServers.filter((server) => server.installId === install.id);
        return (
          <InstalledPluginRow
            key={install.id}
            params={pluginParamsFor(install)}
            summary={
              servers.length === 1 ? t`1 connector` : t`${ph({ count: servers.length })} connectors`
            }
            signIn={servers.some(mcpServerNeedsSignIn)}
            onOpenPlugin={onOpenPlugin}
          />
        );
      })}
      {standaloneServers.map((server) => (
        <SavedServerRow
          key={server.id}
          server={server}
          pending={pending}
          oauthServerId={oauthServerId}
          onAuthorize={onAuthorize}
        />
      ))}
      {sources.map((source) => (
        <View key={source.id} testID="tool-source" style={styles.row}>
          <ConnectorIcon name={source.name} size={LOGO_SIZE} />
          <View style={styles.grow}>
            <Text numberOfLines={1} style={styles.title}>
              {source.name}
            </Text>
            <Text numberOfLines={1} style={styles.secondary}>
              {source.kind === "api" ? "OpenAPI" : source.kind === "graphql" ? "GraphQL" : "MCP"}
            </Text>
          </View>
          <NativeActionButton
            fill={false}
            label={pending === source.id ? t`Removing…` : t`Remove`}
            onPress={() => onRemoveSource(source)}
            prominence="destructive"
          />
        </View>
      ))}
    </View>
  );
}
