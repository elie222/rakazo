import { Trans, useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type {
  MessagingAgentConnection,
  MessagingChannelMembership,
  MessagingInstallationsStatus,
  MessagingStatus,
} from "@rakazo/contracts";
import {
  abortableDelay,
  createMessagingLinkGuard,
  isRetryableError,
  messagingChatApps,
  messagingRequests,
} from "@rakazo/core";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, EllipsisIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";

import { SettingsGroup, SettingsRow } from "../../components/settings/SettingsRows";
import { providerLabel } from "../../lib/integrations/messaging";
import { useQueryUserId, useSpaceQueries } from "../../lib/query/query";
import { rpc } from "../../lib/query/rpc";
import { useEventListener } from "../../lib/use-event-listener";
import { ExternalConversationSettings } from "./ExternalConversationSettings";

const LINK_POLL_MS = 3_000;
const NO_INSTALLATIONS: MessagingInstallationsStatus = { available: false, installations: [] };

function Row({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 text-body text-foreground/75">
      <span className="min-w-0 truncate">{children}</span>
      <span className="flex shrink-0 gap-2">{actions}</span>
    </li>
  );
}

/** A request is a sentence: it wraps instead of losing its end, and describes its buttons. */
function RequestRow({
  children,
  onRespond,
}: {
  children: ReactNode;
  onRespond: (accept: boolean) => void;
}) {
  const id = useId();
  return (
    <li className="flex items-center justify-between gap-3 text-body text-foreground/75">
      <span id={id} className="min-w-0 break-words">
        {children}
      </span>
      <span className="flex shrink-0 gap-2">
        <Button size="sm" aria-describedby={id} onClick={() => onRespond(true)}>
          <Trans>Allow</Trans>
        </Button>
        <Button
          size="sm"
          variant="secondary"
          aria-describedby={id}
          onClick={() => onRespond(false)}
        >
          <Trans>Decline</Trans>
        </Button>
      </span>
    </li>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <span className="ml-2 text-label text-muted-foreground/70">{children}</span>;
}

function InviteText({ channel, agent }: { channel: MessagingChannelMembership; agent: string }) {
  const group = channel.name ?? "";
  const app = providerLabel(channel.provider);
  return (
    <>
      {group ? (
        <Trans>
          {agent} was invited to {group}
        </Trans>
      ) : (
        <Trans>{agent} was invited to a group</Trans>
      )}
      <Meta>
        <Trans>{app} group</Trans>
      </Meta>
    </>
  );
}

function ConnectionRequestText({
  connection,
  agent,
}: {
  connection: MessagingAgentConnection;
  agent: string | undefined;
}) {
  const owner = connection.peerOwnerLabel;
  const peer = connection.peerBotName;
  return agent ? (
    <Trans>
      {owner}'s {peer} wants to connect to {agent}
    </Trans>
  ) : (
    <Trans>
      {owner}'s {peer} wants to connect to your bot
    </Trans>
  );
}

function AppLabel({ provider, detail }: { provider: string; detail?: string }) {
  return (
    <>
      <p>{providerLabel(provider)}</p>
      {detail ? <p className="mt-0.5 text-body-sm text-muted-foreground">{detail}</p> : null}
    </>
  );
}

export function MessagingSettingsPanel() {
  const { t } = useLingui();
  const [settingsConversationId, setSettingsConversationId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const userId = useQueryUserId();
  const linkGuard = useMemo(
    () => createMessagingLinkGuard(queryClient, userId ?? ""),
    [queryClient, userId],
  );
  const issuingLink = useSyncExternalStore(
    linkGuard.subscribe,
    linkGuard.isPending,
    linkGuard.isPending,
  );
  const [linkRequest, setLinkRequest] = useState<{
    code: string;
    expiresAt: string;
    shared?: boolean;
    botId: string;
    provider: string;
    /** The row whose action issued the code, where it is shown. */
    row: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const queries = useSpaceQueries();
  const statusOptions = queries.messaging.status.queryOptions();
  const channelsOptions = queries.messaging.channels.list.queryOptions();
  const connectionsOptions = queries.messaging.connections.list.queryOptions();
  const botsOptions = queries.bots.list.queryOptions();
  const spacesOptions = queries.spaces.list.queryOptions();
  const installationsOptions = queries.messaging.installations.list.queryOptions();
  const statusQuery = useQuery(statusOptions);
  const channelsQuery = useQuery(channelsOptions);
  const connectionsQuery = useQuery(connectionsOptions);
  const botsQuery = useQuery(botsOptions);
  const spacesQuery = useQuery(spacesOptions);
  const installationsQuery = useQuery(installationsOptions);
  const status = statusQuery.data ?? null;
  const channels = channelsQuery.data ?? [];
  const connections = connectionsQuery.data ?? [];
  const bots = botsQuery.data ?? [];
  const externalConversations = spacesQuery.data?.current.externalConversations ?? [];
  const installationStatus = installationsQuery.data ?? NO_INSTALLATIONS;
  // A failed refresh is shown even over cached settings.
  const loadFailed = [
    statusQuery,
    channelsQuery,
    connectionsQuery,
    botsQuery,
    spacesQuery,
    installationsQuery,
  ].some((query) => query.isError);
  const shownError = error ?? (loadFailed ? t`Couldn't load messaging settings` : null);

  /** Reads everything again with requests sent after a change. */
  async function refresh() {
    await Promise.all([
      fetchFresh(queryClient, statusOptions),
      fetchFresh(queryClient, channelsOptions),
      fetchFresh(queryClient, connectionsOptions),
      fetchFresh(queryClient, botsOptions),
      fetchFresh(queryClient, spacesOptions),
      fetchFresh(queryClient, installationsOptions),
    ]);
  }

  const untilLinkExpiry = useMemo(
    () => (linkRequest ? Math.max(0, Date.parse(linkRequest.expiresAt) - Date.now()) : null),
    [linkRequest],
  );
  useTimeout(() => setLinkRequest(null), untilLinkExpiry, linkRequest);
  // Linking completes in the chat app: watch for a new or reassigned identity.
  useEffect(() => {
    if (!linkRequest) return;
    const known = new Map(status?.identities.map((identity) => [identity.id, identity.botId]));
    const stopped = new AbortController();
    void (async () => {
      while (true) {
        await abortableDelay(LINK_POLL_MS, stopped.signal);
        if (stopped.signal.aborted) return;
        try {
          const next = await rpc.messaging.status();
          if (stopped.signal.aborted) return;
          if (
            next.identities.some(
              (identity) =>
                identity.provider === linkRequest.provider &&
                identity.botId === linkRequest.botId &&
                known.get(identity.id) !== identity.botId,
            )
          ) {
            stopped.abort();
            // Cleared before waiting, and only if still this code: a newer one may follow.
            setLinkRequest((current) => (current === linkRequest ? null : current));
            await writeSaved(queryClient, statusOptions.queryKey, () => next);
            await refresh();
            return;
          }
        } catch (error) {
          // A transient failure can be retried while the code is valid.
          if (!isRetryableError(error)) return;
        }
      }
    })();
    return () => stopped.abort();
  }, [linkRequest]);

  async function act(action: () => Promise<unknown>) {
    linkGuard.invalidate();
    setError(null);
    setLinkRequest(null);
    try {
      await action();
      await refresh();
    } catch {
      setError(t`Couldn't update messaging settings`);
    }
  }

  // A failed read shows through the queries' error.
  useEventListener(window, "focus", () => void refresh().catch(() => undefined));

  useEffect(
    () => () => {
      linkGuard.invalidate();
    },
    [linkGuard],
  );
  const botName = (botId: string) => bots.find((bot) => bot.id === botId)?.name;
  // A joined group names its agent only once a second chat app is linked: the
  // same group can then hold two of the caller's memberships, one per agent.
  const agentByIdentity = new Map(status?.identities.map((i) => [i.id, i.botName]) ?? []);
  function channelMeta(channel: MessagingChannelMembership): string {
    return [
      providerLabel(channel.provider),
      agentByIdentity.size > 1 ? agentByIdentity.get(channel.identityId) : undefined,
    ]
      .filter(Boolean)
      .join(", ");
  }

  const identities = status?.identities ?? [];
  const slackInstallations = installationStatus.installations.filter(
    (installation) => installation.provider === "slack",
  );
  const { installable, installProviders, linkProviders, otherIdentities } = messagingChatApps({
    providers: (status?.providers ?? []).filter(
      (provider) => provider !== "slack" || installationsQuery.isSuccess,
    ),
    installAvailable: installationsQuery.isSuccess && installationStatus.available,
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
    Boolean(installationStatus.personalLinkAvailable) &&
    Boolean(status?.providers.includes("slack"));
  const { invites, connectionRequests } = messagingRequests({ status, channels, connections });
  const joinedChannels = channels.filter((channel) => channel.status === "approved");
  const otherConnections = connections.filter(
    (connection) =>
      connection.status === "approved" || (connection.status === "pending" && !connection.incoming),
  );
  const hasRequests = invites.length > 0 || connectionRequests.length > 0;
  const hasConversations =
    joinedChannels.length > 0 || otherConnections.length > 0 || externalConversations.length > 0;
  const hasChatApps = showSlack || linkProviders.length > 0 || otherIdentities.length > 0;

  async function startLink(row: string, provider: string, botId: string) {
    const request = linkGuard.begin();
    if (!request) return;
    setError(null);
    setLinkRequest(null);
    try {
      const issued = await rpc.messaging.link.start({ botId });
      if (!request.isCurrent()) return;
      setLinkRequest({ ...issued, botId, provider, row });
    } catch {
      if (request.isCurrent()) setError(t`Couldn't update messaging settings`);
    } finally {
      request.finish();
    }
  }

  function installSlack() {
    const popup = window.open("about:blank", "rakazo-slack-install");
    if (popup) popup.opener = null;
    void act(async () => {
      try {
        const { url } = await rpc.messaging.installations.start({});
        if (popup) popup.location.href = url;
        else window.location.assign(url);
      } catch (error) {
        popup?.close();
        throw error;
      }
    });
  }

  const connectLabel = (provider: string) => {
    const app = providerLabel(provider);
    return t`Connect ${app}`;
  };
  const optionsLabel = (provider: string) => {
    const app = providerLabel(provider);
    return t`Options for ${app}`;
  };

  /**
   * Issues a code for `provider`. With a choice of bots it asks which first, showing the
   * ones already linked elsewhere as unavailable.
   */
  function linkAction(row: string, provider: string, label: ReactNode, ariaLabel?: string) {
    const only = bots.length === 1 && !linkedBots.has(bots[0]!.id) ? bots[0] : undefined;
    if (only || bots.length === 0) {
      return (
        <Button
          size="sm"
          variant="outline"
          aria-label={ariaLabel}
          disabled={issuingLink || !only}
          onClick={() => only && void startLink(row, provider, only.id)}
        >
          {label}
        </Button>
      );
    }
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={issuingLink}
          render={<Button size="sm" variant="outline" aria-label={ariaLabel} />}
        >
          {label}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-44">
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              <Trans>Bot</Trans>
            </DropdownMenuLabel>
            {botItems(row, provider)}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const botItems = (row: string, provider: string, currentBotId?: string) =>
    bots.map((bot) => (
      <DropdownMenuItem
        key={bot.id}
        disabled={linkedBots.has(bot.id)}
        onClick={() => void startLink(row, provider, bot.id)}
      >
        {bot.name}
        {bot.id === currentBotId ? <CheckIcon className="ml-auto" aria-label={t`Current`} /> : null}
      </DropdownMenuItem>
    ));

  /** A connected row's one control: its actions, the removing one last. */
  function rowMenu(
    provider: string,
    actions: ReactNode,
    remove: { label: ReactNode; run: () => Promise<unknown> },
  ) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button size="icon-sm" variant="outline" aria-label={optionsLabel(provider)} />}
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-44">
          {actions ? (
            <>
              {actions}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem variant="destructive" onClick={() => void act(remove.run)}>
            {remove.label}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  /** The code to send, under the row that asked for it. */
  function linkCodeFor(row: string) {
    if (!linkRequest || linkRequest.row !== row) return null;
    const code = linkRequest.code;
    const app = providerLabel(linkRequest.provider);
    const address = status?.addresses?.[linkRequest.provider];
    return (
      <>
        <p className="mt-2 text-body text-foreground/75" data-testid="messaging-link-code">
          {address ? (
            <Trans>
              Send <span className="font-mono text-foreground">{code}</span> to{" "}
              <span className="text-foreground">{address}</span> from {app} within 10 minutes.
            </Trans>
          ) : (
            <Trans>
              Send <span className="font-mono text-foreground">{code}</span> from {app} within 10
              minutes.
            </Trans>
          )}
        </p>
        {linkRequest.shared ? (
          <p className="mt-1 text-body-sm text-muted-foreground">
            <Trans>Everyone in this bot's space can read the chats it gets from {app}.</Trans>
          </p>
        ) : null}
      </>
    );
  }

  /**
   * A linked account. `movable` offers a code for another bot: sent from this account, it
   * moves the same link, chats and all.
   */
  const identityRow = (identity: MessagingStatus["identities"][number], movable = false) => (
    <SettingsRow
      key={identity.id}
      label={
        <AppLabel
          provider={identity.provider}
          detail={`${identity.address}, ${identity.botName}`}
        />
      }
      control={rowMenu(
        identity.provider,
        movable && bots.length > 1 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={issuingLink}>
              <Trans>Change bot</Trans>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {botItems(`identity:${identity.id}`, identity.provider, identity.botId)}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null,
        {
          label: <Trans>Unlink</Trans>,
          run: () => rpc.messaging.identities.unlink({ identityId: identity.id }),
        },
      )}
    >
      {linkCodeFor(`identity:${identity.id}`)}
    </SettingsRow>
  );

  const memberLinkRow = (
    <SettingsRow
      label={<AppLabel provider="slack" />}
      control={linkAction("member", "slack", <Trans>Link DMs</Trans>)}
    >
      {linkCodeFor("member")}
    </SettingsRow>
  );

  return (
    <div data-testid="messaging-settings" className="space-y-8">
      {shownError ? <p className="text-body-sm text-destructive">{shownError}</p> : null}

      {hasRequests ? (
        <section>
          <SectionHeading variant="label">
            <Trans>Requests</Trans>
          </SectionHeading>
          <ul className="mt-3 space-y-3">
            {invites.map(({ channel, agent }) => (
              <RequestRow
                key={channel.id}
                onRespond={(accept) =>
                  void act(() =>
                    rpc.messaging.channels.respond({ membershipId: channel.id, accept }),
                  )
                }
              >
                <InviteText channel={channel} agent={agent ?? t`Your bot`} />
              </RequestRow>
            ))}
            {connectionRequests.map(({ connection, agent }) => (
              <RequestRow
                key={connection.id}
                onRespond={(accept) =>
                  void act(() =>
                    rpc.messaging.connections.respond({ connectionId: connection.id, accept }),
                  )
                }
              >
                <ConnectionRequestText connection={connection} agent={agent} />
              </RequestRow>
            ))}
          </ul>
        </section>
      ) : null}

      {hasChatApps ? (
        <SettingsGroup data-testid="messaging-chat-apps">
          {/* Saved workspaces stay listed even when a refresh fails. */}
          {slackInstallations.map((installation) => (
            <SettingsRow
              key={installation.id}
              label={
                <AppLabel
                  provider="slack"
                  detail={[
                    installation.workspaceName,
                    installation.botName ?? botName(installation.botId),
                  ]
                    .filter(Boolean)
                    .join(", ")}
                />
              }
              control={rowMenu(
                installation.provider,
                status?.providers.includes(installation.provider) ? (
                  <DropdownMenuItem
                    disabled={issuingLink}
                    onClick={() =>
                      void startLink(
                        `install:${installation.id}`,
                        installation.provider,
                        installation.botId,
                      )
                    }
                  >
                    <Trans>Link DMs</Trans>
                  </DropdownMenuItem>
                ) : null,
                {
                  label: <Trans>Disconnect</Trans>,
                  run: () => rpc.messaging.installations.remove({ id: installation.id }),
                },
              )}
            >
              {linkCodeFor(`install:${installation.id}`)}
            </SettingsRow>
          ))}
          {showSlack ? identitiesOf("slack").map((identity) => identityRow(identity)) : null}
          {slackInstall && slackInstallations.length === 0 ? (
            <SettingsRow
              label={<AppLabel provider="slack" />}
              control={
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={connectLabel("slack")}
                  onClick={installSlack}
                >
                  <Trans>Connect</Trans>
                </Button>
              }
            />
          ) : null}
          {memberLink ? memberLinkRow : null}
          {slackInstall && slackInstallations.length ? (
            <button
              type="button"
              onClick={installSlack}
              className="flex w-full items-center gap-2 px-4 py-3 text-start text-body text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <PlusIcon className="size-4" aria-hidden />
              <Trans>Add workspace</Trans>
            </button>
          ) : null}
          {linkProviders.map((provider) => {
            const linked = identitiesOf(provider);
            if (linked.length) return linked.map((identity) => identityRow(identity, true));
            return (
              <SettingsRow
                key={provider}
                label={<AppLabel provider={provider} />}
                control={linkAction(
                  `app:${provider}`,
                  provider,
                  <Trans>Connect</Trans>,
                  connectLabel(provider),
                )}
              >
                {linkCodeFor(`app:${provider}`)}
              </SettingsRow>
            );
          })}
          {otherIdentities.map((identity) => identityRow(identity))}
        </SettingsGroup>
      ) : null}

      {hasConversations ? (
        <section>
          <SectionHeading variant="label">
            <Trans>Conversations</Trans>
          </SectionHeading>
          <ul className="mt-3 space-y-3">
            {joinedChannels.map((channel) => (
              <Row
                key={channel.id}
                actions={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void act(() => rpc.messaging.channels.leave({ membershipId: channel.id }))
                    }
                  >
                    <Trans>Leave</Trans>
                  </Button>
                }
              >
                {channel.name ?? t`Group`}
                <Meta>{channelMeta(channel)}</Meta>
              </Row>
            ))}
            {otherConnections.map((connection) => (
              <Row
                key={connection.id}
                actions={
                  connection.status === "approved" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void act(() =>
                          rpc.messaging.connections.revoke({ connectionId: connection.id }),
                        )
                      }
                    >
                      <Trans>Revoke</Trans>
                    </Button>
                  ) : (
                    <Meta>
                      <Trans>Pending</Trans>
                    </Meta>
                  )
                }
              >
                {connection.peerOwnerLabel}
                {"'s "}
                {connection.peerBotName}
              </Row>
            ))}
            {externalConversations.map((conversation) => {
              const bot = bots.find((candidate) => candidate.id === conversation.botId);
              const open = settingsConversationId === conversation.id;
              return (
                <li key={conversation.id} className="text-body text-foreground/75">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">
                      {conversation.displayName || t`External conversation`}
                      <Meta>{providerLabel(conversation.provider)}</Meta>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSettingsConversationId(open ? null : conversation.id)}
                    >
                      {open ? <Trans>Close</Trans> : <Trans>Settings</Trans>}
                    </Button>
                  </div>
                  {open && bot ? (
                    <div className="mt-4 rounded-lg border border-border px-3 py-3">
                      <ExternalConversationSettings
                        conversation={conversation}
                        bot={bot}
                        onSave={async (policy, client) => {
                          await client.externalConversations.updatePolicy({
                            externalConversationId: conversation.id,
                            ...policy,
                          });
                          await refresh();
                        }}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
