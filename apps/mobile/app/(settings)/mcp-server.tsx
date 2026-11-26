import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { mcpServerConnection } from "@rakazo/contracts";
import type { McpServerAccess } from "@rakazo/core";
import { mcpHeaderEditValid, sameMcpServerAccess } from "@rakazo/core";
import { mcpServerStatusLabel } from "@rakazo/i18n/plugin-catalog";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { BotAvatar } from "../../components/bots/bot-avatar";
import { NativeActionButton } from "../../components/native/native-action-button";
import { NativeSegmentedControl } from "../../components/native/native-segmented-control";
import { NativeSymbol } from "../../components/native/native-symbol";
import {
  SettingsGroup,
  SettingsInputRow,
  SettingsRow,
  SettingsSwitch,
} from "../../components/settings/settings-group";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import type { RemoteMcpServerEdit } from "../../lib/integrations/mcp-server-edit";
import {
  mcpAdvancedInUse,
  remoteMcpServerChanged,
  remoteMcpServerEdit,
  remoteMcpServerUpdate,
} from "../../lib/integrations/mcp-server-edit";
import { useSideInsets } from "../../lib/layout/side-insets";
import { announceToScreenReader } from "../../lib/native/announce";
import { native, useThemedStyles } from "../../lib/native/native";
import { useScreenHeader } from "../../lib/navigation/screen-header";
import { formRead, rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";

type Draft = RemoteMcpServerEdit & { access: McpServerAccess };

/** One MCP server added to the account: its name, URL, token and which bots can use it. */
export default function McpServerRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // Another server opened in the same screen starts from its own settings.
  return <McpServerScreen key={id} id={id} />;
}

function McpServerScreen({ id }: { id: string }) {
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useLingui();
  const serversRead = formRead(rpcQuery("mcp/servers/list"));
  const botsRead = formRead(rpcQuery("bots/list"));
  const assignmentsRead = formRead(rpcQuery("mcp/assignments/all"));
  // A new read never replaces the draft, and a foreground read picks up a finished install.
  const servers = useScreenQuery(serversRead);
  const botsQuery = useScreenQuery(botsRead, { onForeground: false });
  const assignments = useScreenQuery(assignmentsRead, { onForeground: false });
  const server = servers.data?.find((item) => item.id === id) ?? null;
  const bots = (botsQuery.data ?? []).filter((bot) => !bot.archivedAt);
  const savedAccess: McpServerAccess = {
    allBots: server?.allBots ?? false,
    botIds: bots
      .filter((bot) =>
        (assignments.data ?? []).some((row) => row.botId === bot.id && row.serverId === id),
      )
      .map((bot) => bot.id),
  };
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const saved = server ? remoteMcpServerEdit(server) : null;
  const draft: Draft = {
    name: "",
    endpoint: "",
    token: "",
    transport: "streamable_http",
    headerName: "",
    headerValue: "",
    oauthClientId: "",
    oauthClientSecret: "",
    oauthScope: "",
    oauthParams: "",
    verbatimResults: false,
    ...saved,
    access: savedAccess,
    ...edits,
  };
  const remote = server ? server.transport !== "stdio" : false;
  const configChanged = Boolean(server && remote && remoteMcpServerChanged(server, draft));
  const accessChanged = !sameMcpServerAccess(draft.access, savedAccess);

  const saveFailure = (failure: Error) => errorText(failure, t`Could not save`);
  const save = useSave({
    save: async (next: Draft, send) => {
      if (!server) return;
      const config = configChanged ? remoteMcpServerUpdate(server, next) : null;
      const access = accessChanged ? next.access : undefined;
      // Settings and access go in one save, so neither is ever kept without the other.
      if (config && access) await send("mcp/servers/save", { id, config, access });
      else if (config) await send("mcp/servers/update", { id, config });
      else if (access) await send("mcp/servers/agents", { id, ...access });
    },
    stale: [serversRead.queryKey, assignmentsRead.queryKey],
    onSaved: () => setEdits({}),
    onFailed: (failure) => announceToScreenReader(saveFailure(failure)),
  });
  const test = useSave({
    save: (_, send) => send("mcp/servers/test", { id }),
    stale: [serversRead.queryKey],
  });
  const remove = useSave({
    save: (_, send) => send("mcp/servers/remove", { id }),
    onSaved: () => router.back(),
    closesScreen: true,
  });
  const busy = save.pending || test.pending || remove.pending;
  // A server deleted elsewhere leaves nothing to show or edit. Only a list that was just read
  // says so: one still being read, or one whose new read failed, may be out of date.
  const gone = servers.isSuccess && !servers.isFetching && !server && !remove.pending;
  useEffect(() => {
    if (gone) router.back();
  }, [gone, router]);
  const loadFailure = servers.error ?? botsQuery.error ?? assignments.error;
  const error = save.error
    ? saveFailure(save.error)
    : test.error
      ? errorText(test.error, t`Could not test MCP server`)
      : remove.error
        ? errorText(remove.error, t`Could not delete MCP server`)
        : loadFailure
          ? errorText(loadFailure, t`Could not load MCP servers`)
          : null;
  // Access is saved whole, so it waits for every bot and assignment to load.
  const ready = Boolean(server && botsQuery.data && assignments.data);
  const valid =
    Boolean(draft.name.trim()) &&
    (!remote ||
      (Boolean(draft.endpoint.trim()) &&
        !!server &&
        mcpHeaderEditValid(server.headerKeys, draft.headerName, draft.headerValue)));

  useScreenHeader({
    title: server?.name ?? "",
    action: {
      label: t`Save`,
      disabled: !ready || !valid || !(configChanged || accessChanged),
      busy,
      onPress: () => save.run(draft),
    },
  });

  function edit(patch: Partial<Draft>) {
    save.reset();
    test.reset();
    remove.reset();
    setEdits((current) => ({ ...current, ...patch }));
  }

  function toggleBot(botId: string) {
    const { botIds } = draft.access;
    edit({
      access: {
        allBots: false,
        botIds: botIds.includes(botId)
          ? botIds.filter((item) => item !== botId)
          : [...botIds, botId],
      },
    });
  }

  function confirmDelete() {
    if (!server) return;
    Alert.alert(t`Delete ${ph({ name: server.name })}?`, undefined, [
      { text: t`Cancel`, style: "cancel" },
      { text: t`Delete`, style: "destructive", onPress: () => remove.run() },
    ]);
  }

  const state = server ? mcpServerConnection(server) : null;
  return (
    <ScrollView
      style={[styles.screen, sideInsets]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      {!server && servers.isFetching ? (
        <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t`Loading…`} />
      ) : null}
      {server && state ? (
        <>
          <SettingsGroup>
            <SettingsRow
              key="status"
              title={t`Status`}
              value={test.pending ? t`Checking…` : mcpServerStatusLabel(state)}
              detail={state === "not_working" ? (server.health.message ?? undefined) : undefined}
            />
            <SettingsRow
              key="test"
              title={t`Test connection`}
              tinted
              // A test checks the saved settings, so it waits until edits to them are saved.
              disabled={busy || configChanged || server.health.status === "installing"}
              onPress={() => test.run()}
            />
          </SettingsGroup>
          {remote ? (
            <SettingsGroup label={t`Server`}>
              <SettingsInputRow
                key="name"
                accessibilityLabel={t`Name`}
                placeholder={t`Name`}
                editable={!busy}
                maxLength={120}
                value={draft.name}
                onChangeText={(name) => edit({ name })}
              />
              <SettingsInputRow
                key="endpoint"
                accessibilityLabel={t`Server URL`}
                placeholder="https://example.com/mcp"
                editable={!busy}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                value={draft.endpoint}
                onChangeText={(endpoint) => edit({ endpoint })}
              />
              <SettingsInputRow
                key="token"
                accessibilityLabel={t`Bearer token`}
                placeholder={server.hasSecret ? t`New bearer token` : t`Bearer token (optional)`}
                editable={!busy}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                value={draft.token}
                onChangeText={(token) => edit({ token })}
              />
            </SettingsGroup>
          ) : (
            <SettingsGroup label={t`Server`}>
              <SettingsRow key="command" title={server.command ?? server.slug} />
            </SettingsGroup>
          )}
          {remote ? (
            <SettingsGroup>
              <SettingsRow
                key="advanced"
                title={t`Advanced`}
                value={mcpAdvancedInUse(server) ? t`In use` : undefined}
                chevron={advancedOpen ? "down" : "right"}
                accessibilityState={{ expanded: advancedOpen }}
                onPress={() => setAdvancedOpen((open) => !open)}
              />
            </SettingsGroup>
          ) : null}
          {remote && advancedOpen ? (
            <>
              <SettingsGroup label={t`Transport`}>
                <View key="transport" style={styles.segment}>
                  <NativeSegmentedControl
                    accessibilityLabel={t`Transport`}
                    disabled={busy}
                    value={draft.transport}
                    onChange={(transport) => edit({ transport })}
                    options={[
                      { value: "streamable_http", label: "HTTP" },
                      { value: "sse", label: "SSE" },
                    ]}
                  />
                </View>
              </SettingsGroup>
              <SettingsGroup label={t`Header`}>
                <SettingsInputRow
                  key="header-name"
                  accessibilityLabel={t`Header name`}
                  placeholder={t`Header name`}
                  editable={!busy}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={draft.headerName}
                  onChangeText={(headerName) => edit({ headerName })}
                />
                <SettingsInputRow
                  key="header-value"
                  accessibilityLabel={t`Header value`}
                  placeholder={server.headerKeys.length ? t`New header value` : t`Header value`}
                  editable={!busy}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  value={draft.headerValue}
                  onChangeText={(headerValue) => edit({ headerValue })}
                />
              </SettingsGroup>
              <SettingsGroup label={t`OAuth client`}>
                <SettingsInputRow
                  key="client-id"
                  accessibilityLabel={t`OAuth client ID (optional)`}
                  placeholder={t`OAuth client ID (optional)`}
                  editable={!busy}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={draft.oauthClientId}
                  onChangeText={(oauthClientId) => edit({ oauthClientId })}
                />
                {draft.oauthClientId.trim() ? (
                  <SettingsInputRow
                    key="client-secret"
                    accessibilityLabel={t`OAuth client secret (optional)`}
                    placeholder={t`OAuth client secret (optional)`}
                    editable={!busy}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                    value={draft.oauthClientSecret}
                    onChangeText={(oauthClientSecret) => edit({ oauthClientSecret })}
                  />
                ) : null}
                {draft.oauthClientId.trim() ? (
                  <SettingsInputRow
                    key="scope"
                    accessibilityLabel={t`Scopes (optional)`}
                    placeholder={t`Scopes (optional)`}
                    editable={!busy}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={draft.oauthScope}
                    onChangeText={(oauthScope) => edit({ oauthScope })}
                  />
                ) : null}
                {draft.oauthClientId.trim() ? (
                  <SettingsInputRow
                    key="params"
                    accessibilityLabel={t`Authorization parameters (optional)`}
                    placeholder={t`Authorization parameters (optional)`}
                    editable={!busy}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={draft.oauthParams}
                    onChangeText={(oauthParams) => edit({ oauthParams })}
                  />
                ) : null}
              </SettingsGroup>
              <SettingsGroup>
                <SettingsSwitch
                  key="verbatim"
                  label={t`Keep tool results whole`}
                  disabled={busy}
                  value={draft.verbatimResults}
                  onChange={(verbatimResults) => edit({ verbatimResults })}
                />
              </SettingsGroup>
            </>
          ) : null}
          {ready ? (
            <SettingsGroup label={t`Bots`}>
              <View key="scope" style={styles.segment}>
                <NativeSegmentedControl
                  accessibilityLabel={t`Bots`}
                  disabled={busy}
                  value={draft.access.allBots ? "all" : "chosen"}
                  onChange={(value) =>
                    edit({ access: { ...draft.access, allBots: value === "all" } })
                  }
                  options={[
                    { value: "all", label: t`All bots` },
                    { value: "chosen", label: t`Chosen bots` },
                  ]}
                />
              </View>
              {draft.access.allBots
                ? null
                : bots.map((bot) => (
                    <SettingsRow
                      key={bot.id}
                      title={bot.name}
                      leading={
                        <BotAvatar
                          color={bot.color}
                          avatarSet={bot.avatarSet}
                          identity={bot.id}
                          size={28}
                          status={bot.status}
                        />
                      }
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: draft.access.botIds.includes(bot.id) }}
                      disabled={busy}
                      onPress={() => toggleBot(bot.id)}
                      trailing={
                        draft.access.botIds.includes(bot.id) ? (
                          <NativeSymbol ios="checkmark" android="checkmark" size={16} />
                        ) : null
                      }
                    />
                  ))}
            </SettingsGroup>
          ) : null}
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {loadFailure && !servers.isFetching ? (
        <NativeActionButton
          fill={false}
          label={t`Retry`}
          onPress={() => {
            void servers.refetch();
            void botsQuery.refetch();
            void assignments.refetch();
          }}
          prominence="secondary"
        />
      ) : null}
      {server ? (
        <NativeActionButton
          disabled={busy}
          fill={false}
          label={t`Delete`}
          onPress={confirmDelete}
          prominence="destructive"
        />
      ) : null}
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 16, gap: 20 },
    segment: { paddingHorizontal: 16, paddingVertical: 10 },
    error: { color: mobileTokens().destructive, fontSize: 13 },
  });
}
