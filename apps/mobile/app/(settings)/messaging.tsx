import type { MenuAction, MenuComponentRef } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type {
  MessagingAgentConnection,
  MessagingChannelMembership,
  MessagingStatus,
} from "@rakazo/contracts";
import {
  createMessagingLinkGuard,
  messagingChatApps,
  messagingProviderName,
  messagingRequests,
} from "@rakazo/core";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { NativeActionButton } from "../../components/native/native-action-button";
import { NativeSymbol } from "../../components/native/native-symbol";
import { SettingsGroup, SettingsRow } from "../../components/settings/settings-group";
import { LoadFailure } from "../../components/ui/load-failure";
import { MenuPickerMenu } from "../../components/ui/menu-picker";
import { selectedSpaceId, subscribeSpaceSelection } from "../../lib/api/api";
import { currentSessionGeneration, subscribeSessionGeneration } from "../../lib/api/session";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native/native";
import type { SaveSend } from "../../lib/query/query";
import { formRead, rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";

// One link code is issued at a time per session, across visits to this screen.
const linkScope = {};

export default function MessagingSettings() {
  const { t } = useLingui();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const session = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  const linkGuard = useMemo(() => createMessagingLinkGuard(linkScope, session), [session]);
  const issuingLink = useSyncExternalStore(linkGuard.subscribe, linkGuard.isPending);
  // Re-rendered on a Space switch, so the reads below are for the Space now selected.
  useSyncExternalStore(subscribeSpaceSelection, selectedSpaceId);
  // Requests are answered from what is on screen, so each visit reads everything afresh.
  const definitions = [
    formRead(rpcQuery("bots/list")),
    formRead(rpcQuery("messaging/status")),
    formRead(rpcQuery("messaging/installations/list")),
    formRead(rpcQuery("messaging/channels/list")),
    formRead(rpcQuery("messaging/connections/list")),
    formRead(rpcQuery("spaces/list")),
  ] as const;
  const reads = [
    useScreenQuery(definitions[0]),
    useScreenQuery(definitions[1]),
    useScreenQuery(definitions[2]),
    useScreenQuery(definitions[3]),
    useScreenQuery(definitions[4]),
    useScreenQuery(definitions[5]),
  ] as const;
  const [botsRead, statusRead, installationsRead, channelsRead, connectionsRead, spacesRead] =
    reads;
  // Shown together once every read this visit has answered, as one load.
  const loaded = reads.every((read) => read.isFetchedAfterMount && read.data);
  const bots = (loaded && botsRead.data) || [];
  const status = (loaded && statusRead.data) || null;
  const installations = (loaded && installationsRead.data) || {
    available: false,
    installations: [],
  };
  const channels = (loaded && channelsRead.data) || [];
  const connections = (loaded && connectionsRead.data) || [];
  const rooms = (loaded && spacesRead.data?.current.externalConversations) || [];
  const readFailure = reads.find((read) => read.error)?.error;
  const loadError = readFailure ? errorText(readFailure) : null;
  const reload = () => {
    for (const read of reads) void read.refetch();
  };
  const [link, setLink] = useState<{
    code: string;
    expiresAt: string;
    shared?: boolean;
    botId: string;
    provider: string;
    /** The row whose action issued the code, where it is shown. */
    row: string;
    knownIdentityBots: Record<string, string>;
  } | null>(null);
  const change = useSave({
    save: async (action: (send: SaveSend) => Promise<unknown>, send) => {
      await action(send);
    },
    stale: definitions.map((read) => read.queryKey),
  });
  const issue = useSave({
    save: async (
      input: {
        request: { isCurrent: () => boolean; finish: () => void };
        provider: string;
        row: string;
        botId: string;
        knownIdentityBots: Record<string, string>;
      },
      send,
    ) => {
      try {
        return await send("messaging/link/start", { botId: input.botId });
      } finally {
        input.request.finish();
      }
    },
    onSaved: (issued, { request, provider, row, botId, knownIdentityBots }) => {
      if (request.isCurrent()) setLink({ ...issued, botId, provider, row, knownIdentityBots });
    },
  });
  const busy = change.pending;
  // A code request that was superseded keeps its failure to itself.
  const issueError = issue.error && issue.input?.request.isCurrent() ? issue.error : null;
  const failed = change.error ?? issueError;
  const error = failed ? errorText(failed) : null;
  useFocusEffect(
    useCallback(
      () => () => {
        linkGuard.invalidate();
        setLink(null);
      },
      [linkGuard],
    ),
  );

  useEffect(() => {
    if (!link) return;
    if (
      status?.identities.some(
        (identity) =>
          identity.provider === link.provider &&
          identity.botId === link.botId &&
          link.knownIdentityBots[identity.id] !== identity.botId,
      )
    ) {
      setLink(null);
    }
  }, [link, status]);
  const untilLinkExpiry = useMemo(
    () => (link ? Math.max(0, Date.parse(link.expiresAt) - Date.now()) : null),
    [link],
  );
  useTimeout(() => setLink(null), untilLinkExpiry, link);

  function act(action: (send: SaveSend) => Promise<unknown>) {
    linkGuard.invalidate();
    issue.reset();
    setLink(null);
    change.run(action);
  }

  useEffect(
    () => () => {
      linkGuard.invalidate();
    },
    [linkGuard],
  );
  const botName = (id: string) => bots.find((bot) => bot.id === id)?.name;
  // A joined group names its agent only once a second chat app is linked: the
  // same group can then hold two of the caller's memberships, one per agent.
  const agentByIdentity = new Map(status?.identities.map((i) => [i.id, i.botName]) ?? []);
  const channelDetail = (channel: MessagingChannelMembership) =>
    [
      messagingProviderName(channel.provider),
      agentByIdentity.size > 1 ? agentByIdentity.get(channel.identityId) : undefined,
    ]
      .filter(Boolean)
      .join(", ");
  const { invites, connectionRequests } = messagingRequests({ status, channels, connections });
  const inviteTitle = (channel: MessagingChannelMembership, named: string | undefined) => {
    const agent = named ?? t`Your bot`;
    const group = channel.name;
    return group ? t`${agent} was invited to ${group}` : t`${agent} was invited to a group`;
  };
  const inviteDetail = (channel: MessagingChannelMembership) => {
    const app = messagingProviderName(channel.provider);
    return t`${app} group`;
  };
  const connectionRequestTitle = (
    connection: MessagingAgentConnection,
    named: string | undefined,
  ) => {
    const owner = connection.peerOwnerLabel;
    const peer = connection.peerBotName;
    return named
      ? t`${owner}'s ${peer} wants to connect to ${named}`
      : t`${owner}'s ${peer} wants to connect to your bot`;
  };
  const joinedChannels = channels.filter((channel) => channel.status === "approved");
  const otherConnections = connections.filter(
    (connection) =>
      connection.status === "approved" || (connection.status === "pending" && !connection.incoming),
  );
  const identities = status?.identities ?? [];
  const slackInstallations = installations.installations.filter(
    (installation) => installation.provider === "slack",
  );
  const { installable, installProviders, linkProviders, otherIdentities } = messagingChatApps({
    providers: status?.enabled ? status.providers : [],
    installAvailable: installations.available,
    installations: slackInstallations,
    identities,
  });
  const slackInstall = installable.includes("slack");
  const showSlack = installProviders.includes("slack");
  // A bot answers one chat app at a time.
  const linkedBots = new Set(identities.map((identity) => identity.botId));
  const identitiesOf = (provider: string) =>
    identities.filter((identity) => identity.provider === provider);
  // A teammate's workspace: DMs link to a bot of the member's own choosing.
  const memberLink =
    Boolean(installations.personalLinkAvailable) && Boolean(status?.providers.includes("slack"));

  function installSlack() {
    act(async (send) => {
      const { url } = await send("messaging/installations/start", {});
      await Linking.openURL(url);
    });
  }

  function startLink(row: string, provider: string, botId: string) {
    const request = linkGuard.begin();
    if (!request) return;
    change.reset();
    setLink(null);
    issue.run({
      request,
      provider,
      row,
      botId,
      knownIdentityBots: Object.fromEntries(
        identities.map((identity) => [identity.id, identity.botId]),
      ),
    });
  }

  const textAction = (
    label: string,
    onPress: (send: SaveSend) => Promise<unknown>,
    prominence: "primary" | "quiet" | "destructive" = "quiet",
  ) => (
    <NativeActionButton
      label={label}
      prominence={prominence}
      size="compact"
      fill={false}
      variant={prominence === "primary" ? undefined : "text"}
      disabled={busy || issuingLink}
      onPress={() => act(onPress)}
    />
  );
  const connectLabel = (provider: string) => {
    const app = messagingProviderName(provider);
    return t`Connect ${app}`;
  };
  const optionsLabel = (provider: string) => {
    const app = messagingProviderName(provider);
    return t`Options for ${app}`;
  };
  /**
   * Issues a code for `provider`. With a choice of bots it asks which first, showing the
   * ones already linked elsewhere as unavailable.
   */
  const linkAction = (row: string, provider: string, label: string, accessibilityLabel = label) => {
    const first = bots[0];
    const only = bots.length === 1 && first && !linkedBots.has(first.id) ? first : undefined;
    const disabled = busy || issuingLink;
    if (only || bots.length === 0) {
      return (
        <NativeActionButton
          label={label}
          accessibilityLabel={accessibilityLabel}
          prominence="quiet"
          size="compact"
          fill={false}
          variant="text"
          disabled={disabled || !only}
          onPress={() => only && startLink(row, provider, only.id)}
        />
      );
    }
    return (
      <MenuPickerMenu
        label={t`Bot`}
        choices={bots.map((bot) => ({
          key: bot.id,
          label: bot.name,
          disabled: linkedBots.has(bot.id),
        }))}
        value=""
        disabled={disabled}
        onChange={(botId) => startLink(row, provider, botId)}
      >
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={{ disabled }}
        >
          <Text style={[styles.link, disabled && styles.disabled]}>{label}</Text>
        </View>
      </MenuPickerMenu>
    );
  };
  /** The code to send, right under the row that asked for it. */
  const linkCode = (row: string) => {
    if (!link || link.row !== row || Date.parse(link.expiresAt) <= Date.now()) return null;
    const address = status?.addresses?.[link.provider];
    return (
      <Text key={`code:${row}`} selectable style={styles.code}>
        {address
          ? t`Send ${ph({ code: link.code })} to ${ph({ address })} from ${ph({ app: messagingProviderName(link.provider) })} within 10 minutes.`
          : t`Send ${ph({ code: link.code })} from ${ph({ app: messagingProviderName(link.provider) })} within 10 minutes.`}
        {link.shared
          ? `\n${t`Everyone in this bot's space can read the chats it gets from ${ph({ app: messagingProviderName(link.provider) })}.`}`
          : ""}
      </Text>
    );
  };
  /** A connected row's one control: a native menu of its actions, the removing one last. */
  const rowMenu = (
    provider: string,
    actions: MenuAction[],
    onAction: (id: string) => void,
    remove: { title: string; run: (send: SaveSend) => Promise<unknown> },
  ) => {
    const disabled = busy || issuingLink;
    return (
      <RowOptions
        label={optionsLabel(provider)}
        disabled={disabled}
        actions={[
          ...actions,
          {
            id: "remove-section",
            title: "",
            displayInline: true,
            subactions: [{ id: "remove", title: remove.title, attributes: { destructive: true } }],
          },
        ]}
        onAction={(id) => {
          if (disabled) return;
          if (id === "remove") act(remove.run);
          else onAction(id);
        }}
      />
    );
  };
  /**
   * A linked account. `movable` offers a code for another bot: sent from this account, it
   * moves the same link, chats and all.
   */
  const identityRow = (identity: MessagingStatus["identities"][number], movable = false) => [
    <SettingsRow
      key={identity.id}
      title={messagingProviderName(identity.provider)}
      detail={`${identity.address}, ${identity.botName}`}
      trailing={rowMenu(
        identity.provider,
        movable && bots.length > 1
          ? [
              {
                id: "change",
                title: t`Change bot`,
                subactions: bots.map((bot) => ({
                  id: `bot:${bot.id}`,
                  title: bot.name,
                  attributes: { disabled: linkedBots.has(bot.id) },
                  state: bot.id === identity.botId ? ("on" as const) : undefined,
                })),
              },
            ]
          : [],
        (id) => startLink(`identity:${identity.id}`, identity.provider, id.slice("bot:".length)),
        {
          title: t`Unlink`,
          run: (send) => send("messaging/identities/unlink", { identityId: identity.id }),
        },
      )}
    />,
    linkCode(`identity:${identity.id}`),
  ];
  const respond = (onRespond: (accept: boolean, send: SaveSend) => Promise<unknown>) => (
    <View style={styles.actions}>
      {textAction(t`Allow`, (send) => onRespond(true, send), "primary")}
      {textAction(t`Decline`, (send) => onRespond(false, send))}
    </View>
  );

  const failure = error ?? loadError;
  const shownError = error ?? (status ? loadError : null);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      {failure && !status ? (
        <LoadFailure
          message={failure}
          onRetry={() => {
            change.reset();
            issue.reset();
            reload();
          }}
        />
      ) : shownError ? (
        <Text style={styles.error}>{shownError}</Text>
      ) : null}
      <SettingsGroup label={t`Requests`}>
        {invites.map(({ channel, agent }) => (
          <SettingsRow
            key={channel.id}
            title={inviteTitle(channel, agent)}
            detail={inviteDetail(channel)}
            trailing={respond((accept, send) =>
              send("messaging/channels/respond", { membershipId: channel.id, accept }),
            )}
          />
        ))}
        {connectionRequests.map(({ connection, agent }) => (
          <SettingsRow
            key={connection.id}
            title={connectionRequestTitle(connection, agent)}
            trailing={respond((accept, send) =>
              send("messaging/connections/respond", { connectionId: connection.id, accept }),
            )}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup>
        {slackInstallations.map((installation) => [
          <SettingsRow
            key={installation.id}
            title={messagingProviderName(installation.provider)}
            detail={[
              installation.workspaceName,
              installation.botName ?? botName(installation.botId),
            ]
              .filter(Boolean)
              .join(", ")}
            trailing={rowMenu(
              installation.provider,
              status?.providers.includes(installation.provider)
                ? [{ id: "link-dms", title: t`Link DMs` }]
                : [],
              () =>
                startLink(`install:${installation.id}`, installation.provider, installation.botId),
              {
                title: t`Disconnect`,
                run: (send) => send("messaging/installations/remove", { id: installation.id }),
              },
            )}
          />,
          linkCode(`install:${installation.id}`),
        ])}
        {showSlack ? identitiesOf("slack").map((identity) => identityRow(identity)) : null}
        {slackInstall && slackInstallations.length === 0 ? (
          <SettingsRow
            key="slack"
            title={messagingProviderName("slack")}
            trailing={
              <NativeActionButton
                label={t`Connect`}
                accessibilityLabel={connectLabel("slack")}
                prominence="quiet"
                size="compact"
                fill={false}
                variant="text"
                disabled={busy || issuingLink}
                onPress={installSlack}
              />
            }
          />
        ) : null}
        {memberLink ? (
          <SettingsRow
            key="member"
            title={messagingProviderName("slack")}
            trailing={linkAction("member", "slack", t`Link DMs`)}
          />
        ) : null}
        {memberLink ? linkCode("member") : null}
        {slackInstall && slackInstallations.length ? (
          <SettingsRow
            key="add-workspace"
            accessibilityRole="button"
            disabled={busy || issuingLink}
            onPress={installSlack}
            title={t`Add workspace`}
          />
        ) : null}
        {linkProviders.map((provider) => {
          const linked = identitiesOf(provider);
          if (linked.length) return linked.map((identity) => identityRow(identity, true));
          return [
            <SettingsRow
              key={provider}
              title={messagingProviderName(provider)}
              trailing={linkAction(`app:${provider}`, provider, t`Connect`, connectLabel(provider))}
            />,
            linkCode(`app:${provider}`),
          ];
        })}
        {otherIdentities.map((identity) => identityRow(identity))}
      </SettingsGroup>
      <SettingsGroup label={t`Conversations`}>
        {joinedChannels.map((channel) => (
          <SettingsRow
            key={channel.id}
            title={channel.name ?? t`Group`}
            detail={channelDetail(channel)}
            trailing={textAction(t`Leave`, (send) =>
              send("messaging/channels/leave", { membershipId: channel.id }),
            )}
          />
        ))}
        {otherConnections.map((connection) => (
          <SettingsRow
            key={connection.id}
            title={`${connection.peerOwnerLabel}'s ${connection.peerBotName}`}
            value={connection.status === "pending" ? t`Pending` : undefined}
            trailing={
              connection.status === "approved"
                ? textAction(t`Revoke`, (send) =>
                    send("messaging/connections/revoke", { connectionId: connection.id }),
                  )
                : undefined
            }
          />
        ))}
        {rooms.map((room) => (
          <SettingsRow
            key={room.id}
            title={room.displayName || t`External conversation`}
            detail={messagingProviderName(room.provider)}
            chevron="right"
            accessibilityRole="button"
            onPress={() =>
              router.push({
                pathname: "/team-conversation",
                params: { conversationId: room.id },
              })
            }
          />
        ))}
      </SettingsGroup>
    </ScrollView>
  );
}
/** A connected row's one control: an ellipsis opening a native menu of its actions. */
function RowOptions({
  label,
  actions,
  disabled,
  onAction,
}: {
  label: string;
  actions: MenuAction[];
  disabled: boolean;
  onAction: (id: string) => void;
}) {
  const menu = useRef<MenuComponentRef>(null);
  const colorScheme = useResolvedAppearance();
  const styles = useThemedStyles(createStyles);
  return (
    <View pointerEvents={disabled ? "none" : "auto"} style={disabled && styles.disabled}>
      <MenuView
        ref={menu}
        colorScheme={colorScheme}
        actions={actions}
        onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
      >
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled }}
          // TalkBack's activation does not reach the menu host; open it directly.
          accessibilityActions={
            Platform.OS === "android" && !disabled ? [{ name: "activate" }] : undefined
          }
          onAccessibilityAction={
            Platform.OS === "android"
              ? ({ nativeEvent }) => {
                  if (!disabled && nativeEvent.actionName === "activate") menu.current?.show();
                }
              : undefined
          }
          style={styles.menuButton}
        >
          <NativeSymbol
            ios="ellipsis"
            android="ellipsis-horizontal"
            size={20}
            color={mobileTokens().mutedForeground}
          />
        </View>
      </MenuView>
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    content: { padding: 16, gap: 16 },
    actions: { flexDirection: "row", alignItems: "center", gap: 8 },
    code: { color: native.label, paddingHorizontal: 16, paddingVertical: 12 },
    link: { color: mobileTokens().link, fontSize: 16, fontWeight: "500" },
    disabled: { opacity: 0.45 },
    menuButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
    error: { color: mobileTokens().destructive, padding: 12 },
  });
}
