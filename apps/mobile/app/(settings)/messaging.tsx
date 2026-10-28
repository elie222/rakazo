import type {
  Bot,
  ExternalConversation,
  MessagingAgentConnection,
  MessagingChannelMembership,
  MessagingInstallationsStatus,
  MessagingStatus,
} from "@rakazo/contracts";
import { messagingConnectOptions, messagingProviderName } from "@rakazo/core";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { LoadFailure } from "../../components/load-failure";
import { MenuPicker, MenuPickerMenu } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSymbol } from "../../components/native-symbol";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { errorText } from "../../lib/user-error";

export default function MessagingSettings() {
  const { t } = useI18n();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const [bots, setBots] = useState<Bot[]>([]);
  const [selectedBotId, setSelectedBotId] = useState("");
  const [status, setStatus] = useState<MessagingStatus | null>(null);
  const [installations, setInstallations] = useState<MessagingInstallationsStatus>({
    available: false,
    installations: [],
  });
  const [channels, setChannels] = useState<MessagingChannelMembership[]>([]);
  const [connections, setConnections] = useState<MessagingAgentConnection[]>([]);
  const [rooms, setRooms] = useState<ExternalConversation[]>([]);
  const [link, setLink] = useState<{
    code: string;
    expiresAt: string;
    botId: string;
    provider: string;
    knownIdentityBots: Record<string, string>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const [nextBots, nextStatus, nextInstallations, nextChannels, nextConnections, navigation] =
      await Promise.all([
        rpc("bots/list"),
        rpc("messaging/status"),
        rpc("messaging/installations/list"),
        rpc("messaging/channels/list"),
        rpc("messaging/connections/list"),
        rpc("spaces/list"),
      ]);
    setBots(nextBots);
    setStatus(nextStatus);
    setInstallations(nextInstallations);
    setChannels(nextChannels);
    setConnections(nextConnections);
    setRooms(navigation.current.externalConversations);
    setLoadError(null);
  }, []);
  useFocusEffect(
    useCallback(() => {
      void refresh().catch((err) => setLoadError(errorText(err)));
    }, [refresh]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh().catch((err) => setLoadError(errorText(err)));
    });
    return () => subscription.remove();
  }, [refresh]);

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
      return;
    }
    const timer = setTimeout(
      () => setLink(null),
      Math.max(0, Date.parse(link.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [link, status]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setLoadError(null);
    setLink(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  // A selection archived elsewhere drops out of the list; fall back to the first bot.
  const botId = bots.find((bot) => bot.id === selectedBotId)?.id ?? bots[0]?.id ?? "";
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
    void act(async () => {
      const { url } = await rpc("messaging/installations/start", {});
      await Linking.openURL(url);
    });
  }

  function startLink(provider: string, linkBotId = botId) {
    void act(async () => {
      const issued = await rpc("messaging/link/start", {
        botId: linkBotId,
      });
      setLink({
        ...issued,
        botId: linkBotId,
        provider,
        knownIdentityBots: Object.fromEntries(
          status?.identities.map((identity) => [identity.id, identity.botId]) ?? [],
        ),
      });
    });
  }

  const textAction = (
    label: string,
    onPress: () => Promise<unknown>,
    prominence: "primary" | "quiet" | "destructive" = "quiet",
  ) => (
    <NativeActionButton
      label={label}
      prominence={prominence}
      size="compact"
      fill={false}
      variant={prominence === "primary" ? undefined : "text"}
      disabled={busy}
      onPress={() => void act(onPress)}
    />
  );
  const memberLinkButton = (
    <NativeActionButton
      label={t("Link DMs")}
      prominence="quiet"
      size="compact"
      fill={false}
      variant="text"
      disabled={busy || !botId}
      onPress={() => startLink("slack")}
    />
  );
  const respond = (onRespond: (accept: boolean) => Promise<unknown>) => (
    <View style={styles.actions}>
      {textAction(t("Approve"), () => onRespond(true), "primary")}
      {textAction(t("Decline"), () => onRespond(false))}
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
            setError(null);
            setLoadError(null);
            void refresh().catch((err) => setLoadError(errorText(err)));
          }}
        />
      ) : shownError ? (
        <Text style={styles.error}>{shownError}</Text>
      ) : null}
      <SettingsGroup label={t("Requests")}>
        {invitedChannels.map((channel) => (
          <SettingsRow
            key={channel.id}
            title={channel.name ?? t("Group")}
            detail={channelDetail(channel)}
            trailing={respond((accept) =>
              rpc("messaging/channels/respond", { membershipId: channel.id, accept }),
            )}
          />
        ))}
        {incomingConnections.map((connection) => (
          <SettingsRow
            key={connection.id}
            title={`${connection.peerOwnerLabel}'s ${connection.peerBotName}`}
            trailing={respond((accept) =>
              rpc("messaging/connections/respond", { connectionId: connection.id, accept }),
            )}
          />
        ))}
      </SettingsGroup>
      {slackInstall || slackInstallations.length ? (
        <SettingsGroup>
          {slackInstallations.length === 0 ? (
            <SettingsRow
              title={messagingProviderName("slack")}
              detail={t("Chat with your bot from Slack.")}
              trailing={
                <View style={styles.actions}>
                  {memberLink ? memberLinkButton : null}
                  <NativeActionButton
                    label={t("Connect")}
                    prominence="quiet"
                    size="compact"
                    fill={false}
                    variant="text"
                    disabled={busy}
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
                        label={t("Link DMs")}
                        prominence="quiet"
                        size="compact"
                        fill={false}
                        variant="text"
                        disabled={busy}
                        onPress={() => startLink(installation.provider, installation.botId)}
                      />
                    ) : null}
                    {textAction(
                      t("Disconnect"),
                      () => rpc("messaging/installations/remove", { id: installation.id }),
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
              disabled={busy}
              onPress={installSlack}
              title={t("Add workspace")}
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
              t("Unlink"),
              () => rpc("messaging/identities/unlink", { identityId: identity.id }),
              "destructive",
            )}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup>
        {bots.length > 1 && (connectChoices.length || memberLink) ? (
          <MenuPicker
            label={t("Bot")}
            choices={bots.map((bot) => ({ key: bot.id, label: bot.name }))}
            value={botId}
            onChange={(id) => {
              setSelectedBotId(id);
              setLink(null);
            }}
          />
        ) : null}
        {botId && connectChoices.length ? (
          <MenuPickerMenu
            label={t("Connect a chat app")}
            choices={connectChoices}
            value=""
            disabled={busy}
            onChange={(provider) => startLink(provider)}
          >
            <View>
              <SettingsRow
                accessibilityLabel={t("Connect a chat app")}
                accessibilityRole="button"
                accessible
                title={t("Connect a chat app")}
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
            ? t("Send {code} to {address} from {app} within 10 minutes.", {
                code: link.code,
                address: linkAddress,
                app: messagingProviderName(link.provider),
              })
            : t("Send {code} from {app} within 10 minutes.", {
                code: link.code,
                app: messagingProviderName(link.provider),
              })}
        </Text>
      ) : null}
      <SettingsGroup label={t("Conversations")}>
        {joinedChannels.map((channel) => (
          <SettingsRow
            key={channel.id}
            title={channel.name ?? t("Group")}
            detail={channelDetail(channel)}
            trailing={textAction(t("Leave"), () =>
              rpc("messaging/channels/leave", { membershipId: channel.id }),
            )}
          />
        ))}
        {otherConnections.map((connection) => (
          <SettingsRow
            key={connection.id}
            title={`${connection.peerOwnerLabel}'s ${connection.peerBotName}`}
            value={connection.status === "pending" ? t("Pending") : undefined}
            trailing={
              connection.status === "approved"
                ? textAction(t("Revoke"), () =>
                    rpc("messaging/connections/revoke", { connectionId: connection.id }),
                  )
                : undefined
            }
          />
        ))}
        {rooms.map((room) => (
          <SettingsRow
            key={room.id}
            title={room.displayName || t("External conversation")}
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
