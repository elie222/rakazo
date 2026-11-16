import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { McpServer, PluginPart } from "@rakazo/contracts";
import { mcpServerConnection, mcpServerNeedsSignIn, PluginPreviewSchema } from "@rakazo/contracts";
import {
  catalogItemKey,
  connectCatalogItem,
  installedPluginParts,
  isCatalogItemConnected,
} from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSymbol } from "../../components/native-symbol";
import { PluginIcon } from "../../components/plugin-icon";
import { SkillSymbol } from "../../components/skill-symbol";
import {
  reachesOtherSpaces,
  SpaceAvailabilityPicker,
  useOwnSpaces,
} from "../../components/space-availability";
import { mobileTokens } from "../../lib/appearance";
import { loadLastBotId } from "../../lib/last-bot";
import { native, useThemedStyles } from "../../lib/native";
import type { PluginParams } from "../../lib/plugin-marketplace";
import { sourceHref } from "../../lib/plugin-marketplace";
import type { SaveSend } from "../../lib/query";
import { queryClient, rpcQuery, useSave } from "../../lib/query";
import { useScreenHeader } from "../../lib/screen-header";
import { useScreenQuery } from "../../lib/screen-query";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

const SKILLS_SHOWN = 5;

/** A link without a plugin (an old link, a restored route) lands on Integrations instead. */
export default function PluginRoute() {
  const { source, installedSource, name } = useLocalSearchParams<PluginParams>();
  return source && installedSource && name ? <PluginScreen /> : <Redirect href="/integrations" />;
}

function PluginScreen() {
  const params = useLocalSearchParams<PluginParams>();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useLingui();
  const [lastBotId, setLastBotId] = useState<string | null>(null);
  const [allSkills, setAllSkills] = useState(false);
  const [noAuth, setNoAuth] = useState(new Set<string>());

  useFocusEffect(
    useCallback(() => {
      void loadLastBotId()
        .catch(() => "")
        .then(setLastBotId);
    }, []),
  );
  const botId = lastBotId ?? "";

  const managed = Boolean(params.managedConnectorId && params.managedSlug);
  const installsRead = rpcQuery("capabilities/list");
  const serversRead = rpcQuery("mcp/servers/list");
  const catalogRead = rpcQuery("connections/catalog");
  const connectionsRead = rpcQuery("connections/list");
  const assignmentsRead = rpcQuery("mcp/assignments/list", { botId });
  // Sign-in finishes in the browser, so coming back is the moment to look again.
  const installsQuery = useScreenQuery(installsRead);
  const serversQuery = useScreenQuery(serversRead);
  const catalogQuery = useScreenQuery(catalogRead, { enabled: managed });
  const connectionsQuery = useScreenQuery(connectionsRead, { enabled: managed });
  const assignmentsQuery = useScreenQuery(assignmentsRead, { enabled: Boolean(botId) });
  const reads = [installsRead, serversRead, catalogRead, connectionsRead, assignmentsRead].map(
    (read) => read.queryKey,
  );

  const installs = installsQuery.data ?? [];
  const allServers = serversQuery.data ?? [];
  const connections = connectionsQuery.data ?? [];
  const managedApp =
    catalogQuery.data?.find(
      (item) => item.connectorId === params.managedConnectorId && item.slug === params.managedSlug,
    ) ?? null;
  const assigned = new Set(assignmentsQuery.data?.map((row) => row.serverId));
  const loaded =
    Boolean(installsQuery.data && serversQuery.data) &&
    (!managed || Boolean(catalogQuery.data && connectionsQuery.data)) &&
    lastBotId !== null &&
    // Without its assignments a bot is offered every connector.
    (!botId || !assignmentsQuery.isPending);
  const loadFailure =
    installsQuery.error ?? serversQuery.error ?? catalogQuery.error ?? connectionsQuery.error;

  // A pasted URL can differ from the normalized source the install is saved under.
  const savedAs = (source: string | undefined) =>
    installs.find((row) => row.kind === "plugin" && row.source === source);
  const previewRead = rpcQuery("capabilities/pluginPreview", { source: params.source });
  const previewQuery = useQuery(
    {
      ...previewRead,
      enabled: loaded && !savedAs(params.installedSource),
      // The plugin's publisher can change it at any time, so every visit reads it again.
      staleTime: 0,
    },
    queryClient,
  );
  const preview = previewQuery.data ?? null;
  const previewLoading = previewQuery.isLoading;
  const install =
    savedAs(params.installedSource) ?? (preview ? savedAs(preview.installedSource) : undefined);
  const parts = install ? installedPluginParts(install.config) : [];
  const servers =
    install && parts.includes("connector")
      ? allServers.filter((server) => server.installId === install.id)
      : [];
  const installed = Boolean(install);
  const everywhere = reachesOtherSpaces(install?.availability, useOwnSpaces().length);

  const change = useSave({
    save: (
      action: { key: string; failure: string; act: (send: SaveSend) => Promise<unknown> },
      send,
    ) => action.act(send),
    stale: reads,
  });
  const pending = change.pending ? (change.input?.key ?? null) : null;
  const error = change.error
    ? errorText(change.error, change.input?.failure)
    : !installed && previewQuery.error
      ? errorText(previewQuery.error, t`Could not preview plugin`)
      : loadFailure
        ? errorText(loadFailure, t`Could not load plugin`)
        : null;
  const run = (key: string, act: (send: SaveSend) => Promise<unknown>, failure: string) =>
    change.run({ key, failure, act });

  /** The first part installs the plugin; later changes keep its pinned version. */
  const setParts = (key: string, next: PluginPart[], failure: string) =>
    run(
      key,
      async (send) => {
        if (install) await send("capabilities/pluginParts", { id: install.id, parts: next });
        else if (preview)
          await send("capabilities/install", {
            kind: "plugin",
            name: preview.name,
            source: preview.pinnedSource ?? params.source,
            pluginDigest: preview.digest,
            config: {},
            pluginParts: next,
          });
      },
      failure,
    );
  const toggle = (part: PluginPart, on: boolean) =>
    on
      ? [...parts.filter((value) => value !== part), part]
      : parts.filter((value) => value !== part);

  const confirmRemove = (title: string, onConfirm: () => void) =>
    Alert.alert(everywhere ? t`Remove from every space?` : title, undefined, [
      { text: t`Cancel`, style: "cancel" },
      { text: t`Remove`, style: "destructive", onPress: onConfirm },
    ]);

  const connectManaged = () =>
    managedApp &&
    run(
      "header",
      async (send) => {
        const result = await connectCatalogItem(managedApp, connections, {
          begin: (input) => send("connections/begin", input),
          complete: (input) => send("connections/complete", input),
          openUrl: (url) => Linking.openURL(url),
          signal: new AbortController().signal,
        });
        if (result.status === "pending")
          Alert.alert(
            t`Connection pending`,
            t`Finish connecting in the browser, then refresh this page.`,
          );
        else if (botId)
          void send("onboarding/appConnected", {
            botId,
            provider: managedApp.slug,
            connectorId: managedApp.connectorId,
          }).catch(() => undefined);
      },
      t`Could not connect`,
    );

  const signIn = (server: McpServer) =>
    run(
      server.id,
      async (send) => {
        const { webUrl } = await send("integrationSetup/get", undefined);
        const started = await send("mcp/oauth/begin", {
          serverId: server.id,
          redirectUri: new URL("/mcp/oauth/callback", webUrl).toString(),
        });
        if (started.status === "authorization_required")
          await Linking.openURL(started.authorizationUrl);
        else if (started.status === "authorization_not_requested")
          setNoAuth((current) => new Set([...current, server.id]));
      },
      t`Could not sign in`,
    );

  const enable = (server: McpServer) =>
    run(
      server.id,
      (send) => send("mcp/assignments/approve", { botId, serverId: server.id }),
      t`Could not enable tools`,
    );

  const busy = Boolean(pending);
  const parsed = install ? PluginPreviewSchema.safeParse(install.config) : null;
  const detail = parsed?.success ? parsed.data : preview;
  // An ignored manifest field loses nothing, so it isn't reported. A skill left out for repeating
  // a built-in one says why, since the user still has that skill.
  const notAdded = [
    ...(detail?.skipped ?? [])
      .filter((entry) => entry.kind !== "unsupported_field")
      .map((entry) => entry.name),
    ...(detail?.builtinNames ?? []).map((name) => t`${name} (same name as a built-in skill)`),
  ];
  const connectorCount = detail?.mcpServers.length ?? 0;
  // Without a connector there is nothing to connect, so the page adds the skills instead.
  const skillsOnly = params.skillsOnly === "1";
  const skillPack = skillsOnly || (!managed && !connectorCount && Boolean(detail));
  const headerPart: PluginPart = skillPack ? "skills" : "connector";
  const headerOn = parts.includes(headerPart);
  const skillsOn = parts.includes("skills");
  const ready = loaded && Boolean(detail) && (installed || Boolean(preview));
  const managedConnected = managedApp ? isCatalogItemConnected(connections, managedApp) : false;
  const working = pending === "header";
  const action = managed
    ? managedConnected
      ? {
          label: t`Added`,
          onPress: () =>
            router.navigate({
              pathname: "/integrations",
              params: { app: catalogItemKey(managedApp!) },
            }),
          destructive: false,
        }
      : {
          label: working ? t`Connecting…` : t`Connect`,
          onPress: () => void connectManaged(),
          destructive: false,
        }
    : headerOn
      ? {
          label: working ? t`Removing…` : t`Remove`,
          onPress: () =>
            confirmRemove(t`Remove ${ph({ name: params.name })}?`, () => {
              void setParts("header", toggle(headerPart, false), t`Could not remove plugin`);
            }),
          destructive: true,
        }
      : {
          label: working
            ? skillPack
              ? t`Adding…`
              : t`Connecting…`
            : skillPack
              ? t`Add`
              : t`Connect`,
          onPress: () =>
            void setParts("header", toggle(headerPart, true), t`Could not install plugin`),
          destructive: false,
        };
  useScreenHeader({
    title: params.name,
    action: {
      label: action.label,
      prominence: action.destructive ? "destructive" : managedConnected ? "secondary" : "primary",
      disabled: managed ? !managedApp : !ready,
      busy,
      onPress: action.onPress,
    },
  });

  const description = detail?.description || params.description;
  const skills = detail?.skills ?? [];
  const shownSkills = allSkills ? skills : skills.slice(0, SKILLS_SHOWN);
  const prefix = `${detail?.name ?? ""}: `;

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={styles.hero}>
          <PluginIcon logo={params.logo} name={params.name} site={params.site} size={56} />
          <View style={styles.grow}>
            <Text numberOfLines={2} style={styles.name}>
              {params.name}
            </Text>
            <Pressable
              accessibilityRole="link"
              hitSlop={8}
              onPress={() =>
                void Linking.openURL(sourceHref(params.installedSource, detail?.resolvedSha))
              }
              style={styles.sourceLink}
            >
              <Text style={styles.secondary}>{t`View source`}</Text>
              <NativeSymbol
                android="open-outline"
                color={native.secondaryLabel}
                ios="arrow.up.right"
                size={12}
              />
            </Pressable>
          </View>
        </View>

        {description ? <Text style={styles.description}>{description}</Text> : null}
        {install ? (
          <SpaceAvailabilityPicker
            kind="install"
            id={install.id}
            availability={install.availability}
            stale={reads}
          />
        ) : null}

        {error ? (
          <View style={styles.errorRow}>
            <Text style={styles.error}>{error}</Text>
            {!installed && !preview && !previewLoading && loaded ? (
              <NativeActionButton
                fill={false}
                label={t`Retry`}
                // Back to the spinner while it reads again.
                onPress={() => {
                  if (change.error) change.reset();
                  void queryClient.resetQueries({ queryKey: previewRead.queryKey });
                }}
                prominence="secondary"
              />
            ) : null}
          </View>
        ) : null}

        {!loaded || previewLoading ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t`Loading…`} />
        ) : null}

        {!skillsOnly && (managed || connectorCount) ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {t`Apps`} <Text style={styles.count}>{managed ? 1 : connectorCount}</Text>
            </Text>
            <View style={styles.card}>
              {managed ? (
                <View style={[styles.item, styles.itemRow]}>
                  <ConnectorSymbol />
                  <View style={styles.grow}>
                    <Text numberOfLines={1} style={styles.title}>
                      {params.name}
                    </Text>
                    <Text numberOfLines={1} style={styles.secondary}>
                      {t`Connector`}
                    </Text>
                  </View>
                  {managedConnected ? <ConnectedMark label={t`Connected`} /> : null}
                </View>
              ) : servers.length ? (
                servers.map((server, index) => (
                  <View
                    key={server.id}
                    accessibilityLabel={server.name}
                    style={[styles.item, index > 0 && styles.divider]}
                  >
                    <View style={styles.itemRow}>
                      <ConnectorSymbol />
                      <View style={styles.grow}>
                        <Text numberOfLines={1} style={styles.title}>
                          {server.name.startsWith(prefix)
                            ? server.name.slice(prefix.length)
                            : server.name}
                        </Text>
                        <Text numberOfLines={1} style={styles.secondary}>
                          {server.endpoint}
                        </Text>
                      </View>
                      {mcpServerConnection(server) === "connected" ? (
                        <ConnectedMark label={t`Connected`} />
                      ) : null}
                    </View>
                    <View style={styles.itemActions}>
                      {!mcpServerNeedsSignIn(server) || noAuth.has(server.id) ? null : (
                        <NativeActionButton
                          busy={pending === server.id}
                          disabled={busy}
                          fill={false}
                          label={server.oauthStatus === "reconnect" ? t`Reconnect` : t`Sign in`}
                          onPress={() => void signIn(server)}
                          prominence="secondary"
                        />
                      )}
                      {botId ? (
                        assigned.has(server.id) ? (
                          <Text style={styles.secondary}>{t`In this bot`}</Text>
                        ) : (
                          <NativeActionButton
                            disabled={busy}
                            fill={false}
                            label={t`Use in this bot`}
                            onPress={() => void enable(server)}
                            prominence="secondary"
                          />
                        )
                      ) : null}
                    </View>
                  </View>
                ))
              ) : (
                detail?.mcpServers.map((server, index) => (
                  <View
                    key={server.name}
                    style={[styles.item, styles.itemRow, index > 0 && styles.divider]}
                  >
                    <ConnectorSymbol />
                    <View style={styles.grow}>
                      <Text numberOfLines={1} style={styles.title}>
                        {server.name}
                      </Text>
                      <Text numberOfLines={1} style={styles.secondary}>
                        {server.endpoint}
                      </Text>
                    </View>
                  </View>
                ))
              )}
            </View>
          </View>
        ) : null}

        {skills.length ? (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>
                {t`Skills`} <Text style={styles.count}>{skills.length}</Text>
              </Text>
              {skillPack ? null : (
                <NativeActionButton
                  busy={pending === "skills"}
                  disabled={busy || !ready}
                  fill={false}
                  label={skillsOn ? t`Remove skills` : t`Add skills`}
                  onPress={() =>
                    skillsOn
                      ? confirmRemove(t`Remove skills`, () => {
                          void setParts(
                            "skills",
                            toggle("skills", false),
                            t`Could not remove skills`,
                          );
                        })
                      : void setParts("skills", toggle("skills", true), t`Could not add skills`)
                  }
                  prominence={skillsOn ? "destructive" : "secondary"}
                />
              )}
            </View>
            <View style={styles.card}>
              {shownSkills.map((skill, index) => (
                <View
                  key={skill.name}
                  style={[styles.item, styles.itemRow, index > 0 && styles.divider]}
                >
                  <SkillSymbol />
                  <View style={styles.grow}>
                    <Text numberOfLines={1} style={styles.title}>
                      {skill.name}
                    </Text>
                    {skill.description ? (
                      <Text numberOfLines={2} style={styles.secondary}>
                        {skill.description}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
              {skills.length > shownSkills.length ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setAllSkills(true)}
                  style={[styles.item, styles.divider]}
                >
                  <Text style={styles.more}>
                    {t`${ph({ count: skills.length - shownSkills.length })} more`}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}

        {notAdded.length ? (
          <Text style={styles.secondary}>{t`Not added: ${ph({ list: notAdded.join(", ") })}`}</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ConnectorSymbol() {
  return (
    <NativeSymbol android="flash-outline" color={native.secondaryLabel} ios="powerplug" size={15} />
  );
}

function ConnectedMark({ label }: { label: string }) {
  return (
    <View accessible accessibilityLabel={label}>
      <NativeSymbol
        ios="checkmark.circle.fill"
        android="checkmark-circle"
        size={16}
        color={mobileTokens().success}
      />
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 20 },
    hero: { flexDirection: "row", alignItems: "center", gap: 14 },
    grow: { flex: 1, gap: 3, minWidth: 0 },
    name: { color: native.label, fontSize: 22, fontWeight: "600" },
    sourceLink: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" },
    description: { color: native.secondaryLabel, fontSize: 15, lineHeight: 21 },
    section: { gap: 8 },
    sectionTitle: { color: native.label, fontSize: 15, fontWeight: "600", paddingHorizontal: 4 },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    count: { color: native.secondaryLabel, fontWeight: "400" },
    card: { borderRadius: 14, backgroundColor: native.fill, overflow: "hidden" },
    item: { paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
    itemRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    itemActions: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
      paddingLeft: 27,
    },
    divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: native.separator },
    title: { color: native.label, fontSize: 15, fontWeight: "500" },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
    more: { color: native.label, fontSize: 14, textAlign: "right" },
    errorRow: { gap: 8 },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
