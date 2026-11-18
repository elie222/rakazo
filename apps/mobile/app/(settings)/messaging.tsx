import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { MessagingChannelMembership } from "@rakazo/contracts";
import {
  createMessagingLinkGuard,
  messagingConnectOptions,
  messagingProviderName,
} from "@rakazo/core";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { NativeActionButton } from "../../components/native/native-action-button";
import { NativeSymbol } from "../../components/native/native-symbol";
import { SettingsGroup, SettingsRow } from "../../components/settings/settings-group";
import { LoadFailure } from "../../components/ui/load-failure";
import { MenuPicker, MenuPickerMenu } from "../../components/ui/menu-picker";
import { selectedSpaceId, subscribeSpaceSelection } from "../../lib/api/api";
import { currentSessionGeneration, subscribeSessionGeneration } from "../../lib/api/session";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import { native, useThemedStyles } from "../../lib/native/native";
import type { SaveSend } from "../../lib/query/query";
import { formRead, rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";

// One link code is issued at a time per session, across visits to this screen.
const linkScope = {};

export default function MessagingSettings() {
  const { t } = useLingui();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const [selectedBotId, setSelectedBotId] = useState("");
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
    onSaved: (issued, { request, provider, botId, knownIdentityBots }) => {
      if (request.isCurrent()) setLink({ ...issued, botId, provider, knownIdentityBots });
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

  // A selection archived elsewhere drops out of the list; fall back to the first bot.
  const botId = bots.find((bot) => bot.id === selectedBotId)?.id ?? bots[0]?.id ?? "";
  useEffect(() => {
    if (linkGuard.invalidate(true)) {
      setLink(null);
    }
  }, [botId, linkGuard]);
  useEffect(
    () => () => {
      linkGuard.invalidate();
    },
    [linkGuard],
  );
  const botName = (id: string) => bots.find((bot) => bot.id === id)?.name;
  // Only meaningful once a second chat app is linked: the same group can then
  // hold two of the caller's memberships, one per agent.
  const agentByIdentity = new Map(status?.identities.map((i) => [i.id, i.botName]) ?? []);
  const channelDetail = (channel: MessagingChannelMembership) =>
    [
      messagingProviderName(channel.provider),
      agentByIdentity.size > 1 ? agentByIdentity.get(channel.identityId) : undefined,
    ]
      .filter(Boolean)
      .join(", ");
  const invitedChannels = channels.filter((channel) => channel.status === "invited");
  const incomingConnections = connections.filter(
    (connection) => connection.status === "pending" && connection.incoming,
  );
  const joinedChannels = channels.filter((channel) => channel.status === "approved");
  const otherConnections = connections.filter(
    (connection) =>
      connection.status === "approved" || (connection.status === "pending" && !connection.incoming),
  );
  const connectOptions = messagingConnectOptions(
    status?.enabled ? status.providers : [],
    installations.available,
  );
  const slackInstall = connectOptions.some(({ method }) => method === "install");
  const connectChoices = connectOptions
    .filter(({ method }) => method === "link")
    .map(({ provider }) => ({ key: provider, label: messagingProviderName(provider) }));
  const slackInstallations = installations.installations.filter(
    (installation) => installation.provider === "slack",
  );
  // A teammate's workspace: DMs link to a bot of the member's own choosing.
  const memberLink =
    Boolean(installations.personalLinkAvailable) && Boolean(status?.providers.includes("slack"));
  const linkAddress = link ? status?.addresses?.[link.provider] : undefined;

  function installSlack() {
    act(async (send) => {
      const { url } = await send("messaging/installations/start", {});
      await Linking.openURL(url);
    });
  }

  function startLink(provider: string, linkBotId = botId, fromPicker = true) {
    const request = linkGuard.begin(fromPicker);
    if (!request) return;
    change.reset();
    setLink(null);
    issue.run({
      request,
      provider,
      botId: linkBotId,
      knownIdentityBots: Object.fromEntries(
        status?.identities.map((identity) => [identity.id, identity.botId]) ?? [],
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
  const memberLinkButton = (
    <NativeActionButton
      label={t`Link DMs`}
      prominence="quiet"
      size="compact"
      fill={false}
      variant="text"
      disabled={busy || issuingLink || !botId}
      onPress={() => startLink("slack")}
    />
  );
  const respond = (onRespond: (accept: boolean, send: SaveSend) => Promise<unknown>) => (
    <View style={styles.actions}>
      {textAction(t`Approve`, (send) => onRespond(true, send), "primary")}
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
        {invitedChannels.map((channel) => (
          <SettingsRow
            key={channel.id}
            title={channel.name ?? t`Group`}
            detail={channelDetail(channel)}
            trailing={respond((accept, send) =>
              send("messaging/channels/respond", { membershipId: channel.id, accept }),
            )}
          />
        ))}
        {incomingConnections.map((connection) => (
          <SettingsRow
            key={connection.id}
            title={`${connection.peerOwnerLabel}'s ${connection.peerBotName}`}
            trailing={respond((accept, send) =>
              send("messaging/connections/respond", { connectionId: connection.id, accept }),
            )}
          />
        ))}
      </SettingsGroup>
      {slackInstall || slackInstallations.length ? (
        <SettingsGroup>
          {slackInstallations.length === 0 ? (
            <SettingsRow
              title={messagingProviderName("slack")}
              detail={t`Chat with your bot from Slack.`}
              trailing={
                <View style={styles.actions}>
                  {memberLink ? memberLinkButton : null}
                  <NativeActionButton
                    label={t`Connect`}
                    prominence="quiet"
                    size="compact"
                    fill={false}
                    variant="text"
                    disabled={busy || issuingLink}
                    onPress={installSlack}
                  />
                </View>
              }
            />
          ) : (
            slackInstallations.map((installation) => (
              <SettingsRow
                key={installation.id}
                title={messagingProviderName(installation.provider)}
                detail={[
                  installation.workspaceName,
                  installation.botName ?? botName(installation.botId),
                ]
                  .filter(Boolean)
                  .join(", ")}
                trailing={
                  <View style={styles.actions}>
                    {status?.providers.includes(installation.provider) ? (
                      <NativeActionButton
                        label={t`Link DMs`}
                        prominence="quiet"
                        size="compact"
                        fill={false}
                        variant="text"
                        disabled={busy || issuingLink}
                        onPress={() => startLink(installation.provider, installation.botId, false)}
                      />
                    ) : null}
                    {textAction(
                      t`Disconnect`,
                      (send) => send("messaging/installations/remove", { id: installation.id }),
                      "destructive",
                    )}
                  </View>
                }
              />
            ))
          )}
          {memberLink && slackInstallations.length ? (
            <SettingsRow title={messagingProviderName("slack")} trailing={memberLinkButton} />
          ) : null}
          {slackInstall && slackInstallations.length ? (
            <SettingsRow
              accessibilityRole="button"
              disabled={busy || issuingLink}
              onPress={installSlack}
              title={t`Add workspace`}
            />
          ) : null}
        </SettingsGroup>
      ) : null}
      <SettingsGroup>
        {status?.identities.map((identity) => (
          <SettingsRow
            key={identity.id}
            title={messagingProviderName(identity.provider)}
            detail={`${identity.address}, ${identity.botName}`}
            trailing={textAction(
              t`Unlink`,
              (send) => send("messaging/identities/unlink", { identityId: identity.id }),
              "destructive",
            )}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup>
        {bots.length > 1 && (connectChoices.length || memberLink) ? (
          <MenuPicker
            label={t`Bot`}
            choices={bots.map((bot) => ({ key: bot.id, label: bot.name }))}
            value={botId}
            onChange={(id) => {
              if (linkGuard.invalidate(true)) {
                setLink(null);
              }
              setSelectedBotId(id);
            }}
          />
        ) : null}
        {botId && connectChoices.length ? (
          <MenuPickerMenu
            label={t`Connect a chat app`}
            choices={connectChoices}
            value=""
            disabled={busy || issuingLink}
            onChange={(provider) => startLink(provider)}
          >
            <View>
              <SettingsRow
                accessibilityLabel={t`Connect a chat app`}
                accessibilityRole="button"
                accessible
                title={t`Connect a chat app`}
                trailing={
                  <NativeSymbol
                    android="chevron-expand"
                    color={native.tertiaryLabel}
                    ios="chevron.up.chevron.down"
                    size={13}
                  />
                }
              />
            </View>
          </MenuPickerMenu>
        ) : null}
      </SettingsGroup>
      {link && Date.parse(link.expiresAt) > Date.now() ? (
        <Text selectable style={styles.code}>
          {linkAddress
            ? t`Send ${ph({ code: link.code })} to ${ph({ address: linkAddress })} from ${ph({ app: messagingProviderName(link.provider) })} within 10 minutes.`
            : t`Send ${ph({ code: link.code })} from ${ph({ app: messagingProviderName(link.provider) })} within 10 minutes.`}
          {link.shared
            ? `\n${t`Everyone in this bot's space can read the chats it gets from ${ph({ app: messagingProviderName(link.provider) })}.`}`
            : ""}
        </Text>
      ) : null}
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
function createStyles() {
  return StyleSheet.create({
    content: { padding: 16, gap: 16 },
    actions: { flexDirection: "row", alignItems: "center", gap: 8 },
    code: { color: native.label, padding: 12 },
    error: { color: mobileTokens().destructive, padding: 12 },
  });
}
