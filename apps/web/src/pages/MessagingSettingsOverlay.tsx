import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  MessagingAgentConnection,
  MessagingChannelMembership,
  MessagingStatus,
} from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { BuiButton } from "../components/beautiful-ui/primitives";
import { providerLabel } from "../lib/messaging";
import { rpc } from "../lib/rpc";

export function MessagingSettingsOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [status, setStatus] = useState<MessagingStatus | null>(null);
  const [channels, setChannels] = useState<MessagingChannelMembership[]>([]);
  const [connections, setConnections] = useState<MessagingAgentConnection[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [linkBotId, setLinkBotId] = useState("");
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", handleKeyDown);
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  async function refresh() {
    const [nextStatus, nextChannels, nextConnections, nextBots] = await Promise.all([
      rpc.messaging.status(),
      rpc.messaging.channels.list(),
      rpc.messaging.connections.list(),
      rpc.bots.list(),
    ]);
    setStatus(nextStatus);
    setChannels(nextChannels);
    setConnections(nextConnections);
    setBots(nextBots);
  }

  useEffect(() => {
    void refresh().catch(() => setError(t`Couldn't load messaging settings`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(action: () => Promise<unknown>) {
    setError(null);
    // A displayed code must always match the current selection and link
    // state; the link action re-sets it after issuing.
    setLinkCode(null);
    try {
      await action();
      await refresh();
    } catch {
      setError(t`Couldn't update messaging settings`);
    }
  }

  const agentByIdentity = new Map(status?.identities.map((i) => [i.id, i.botName]) ?? []);
  function channelMeta(channel: MessagingChannelMembership): string {
    return [
      providerLabel(channel.provider),
      // Only meaningful once a second chat app is linked: the same group can
      // then hold two of the caller's memberships, one per agent.
      agentByIdentity.size > 1 ? agentByIdentity.get(channel.identityId) : undefined,
      channel.status,
      String(channel.memberCount),
    ]
      .filter(Boolean)
      .join(" · ");
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgba(4,4,5,.62)] p-4 sm:p-10">
      <div
        ref={panelRef}
        data-testid="messaging-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="messaging-settings-title"
        tabIndex={-1}
        className="rk-scroll max-h-full w-[640px] max-w-full overflow-y-auto rounded-[26px] border border-[var(--rk-hairline-strong)] bg-[var(--rk-surface)] p-6 shadow-[0_40px_90px_rgba(0,0,0,.55)] sm:p-8"
      >
        <div className="flex items-start justify-between gap-6">
          <h2
            id="messaging-settings-title"
            className="text-2xl font-medium text-[var(--rk-ink-strong)]"
          >
            <Trans>Messaging</Trans>
          </h2>
          <button
            type="button"
            aria-label={t`Close messaging settings`}
            onClick={onClose}
            className="text-[var(--rk-muted)]"
          >
            ✕
          </button>
        </div>

        {error ? <p className="mt-4 text-[13px] text-[#E88B8B]">{error}</p> : null}

        <section className="mt-8 rounded-[14px] border border-[var(--rk-border)] bg-[var(--rk-inset)] px-4 py-4">
          <h3 className="text-[15px] font-medium text-[var(--rk-ink)]">
            <Trans>Chat apps</Trans>
          </h3>
          {status ? (
            <p className="mt-3 text-[13px] text-[var(--rk-faint)]">
              {status.providers.map(providerLabel).join(" · ")}
            </p>
          ) : null}
          {status?.identities.length ? (
            <ul className="mt-3 space-y-3">
              {status.identities.map((identity) => (
                <li
                  key={identity.id}
                  className="flex items-center justify-between gap-3 text-[14px] text-[var(--rk-soft)]"
                >
                  <span>
                    {providerLabel(identity.provider)} · {identity.address}{" "}
                    <span className="text-[12px] text-[var(--rk-faint)]">→ {identity.botName}</span>
                  </span>
                  <BuiButton
                    onClick={() =>
                      void act(() => rpc.messaging.identities.unlink({ identityId: identity.id }))
                    }
                  >
                    <Trans>Unlink</Trans>
                  </BuiButton>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[14px] text-[var(--rk-soft)]">
              <Trans>No chat apps linked yet.</Trans>
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <select
              aria-label={t`Bot to link`}
              value={linkBotId}
              onChange={(event) => {
                setLinkBotId(event.target.value);
                setLinkCode(null);
              }}
              className="rounded-[10px] border border-[var(--rk-scroll)] bg-[var(--rk-surface)] px-3 py-2 text-[13.5px] text-[var(--rk-ink)]"
            >
              <option value="">{t`Choose a bot…`}</option>
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
            <BuiButton
              tone="accent"
              disabled={!linkBotId}
              onClick={() =>
                void act(async () => {
                  const issued = await rpc.messaging.link.start({ botId: linkBotId });
                  setLinkCode(issued.code);
                })
              }
            >
              <Trans>Link a chat app</Trans>
            </BuiButton>
          </div>
          {linkCode ? (
            <p className="mt-3 text-[14px] text-[var(--rk-soft)]" data-testid="messaging-link-code">
              <Trans>
                Send <span className="font-mono text-[var(--rk-ink-strong)]">{linkCode}</span> to
                the line from your chat app within 10 minutes. You'll get a confirmation reply once
                linked.
              </Trans>
            </p>
          ) : null}
        </section>

        <section className="mt-5 rounded-[14px] border border-[var(--rk-border)] bg-[var(--rk-inset)] px-4 py-4">
          <h3 className="text-[15px] font-medium text-[var(--rk-ink)]">
            <Trans>Channels</Trans>
          </h3>
          {channels.length === 0 ? (
            <p className="mt-3 text-[13px] text-[var(--rk-faint)]">
              <Trans>No group chats yet.</Trans>
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {channels.map((channel) => (
                <li
                  key={channel.id}
                  className="flex items-center justify-between gap-3 text-[14px] text-[var(--rk-soft)]"
                >
                  <span>
                    {channel.name ?? t`Group`}{" "}
                    <span className="text-[12px] text-[var(--rk-faint)]">
                      {channelMeta(channel)}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    {channel.status === "invited" ? (
                      <>
                        <BuiButton
                          tone="accent"
                          onClick={() =>
                            void act(() =>
                              rpc.messaging.channels.respond({
                                membershipId: channel.id,
                                accept: true,
                              }),
                            )
                          }
                        >
                          <Trans>Approve</Trans>
                        </BuiButton>
                        <BuiButton
                          onClick={() =>
                            void act(() =>
                              rpc.messaging.channels.respond({
                                membershipId: channel.id,
                                accept: false,
                              }),
                            )
                          }
                        >
                          <Trans>Decline</Trans>
                        </BuiButton>
                      </>
                    ) : null}
                    {channel.status === "approved" ? (
                      <BuiButton
                        onClick={() =>
                          void act(() => rpc.messaging.channels.leave({ membershipId: channel.id }))
                        }
                      >
                        <Trans>Leave</Trans>
                      </BuiButton>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-5 rounded-[14px] border border-[var(--rk-border)] bg-[var(--rk-inset)] px-4 py-4">
          <h3 className="text-[15px] font-medium text-[var(--rk-ink)]">
            <Trans>Agent connections</Trans>
          </h3>
          {connections.length === 0 ? (
            <p className="mt-3 text-[13px] text-[var(--rk-faint)]">
              <Trans>No agent connections yet.</Trans>
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {connections.map((connection) => (
                <li
                  key={connection.id}
                  className="flex items-center justify-between gap-3 text-[14px] text-[var(--rk-soft)]"
                >
                  <span>
                    {connection.peerOwnerLabel}
                    {"'s "}
                    {connection.peerBotName}{" "}
                    <span className="text-[12px] text-[var(--rk-faint)]">{connection.status}</span>
                  </span>
                  <span className="flex gap-2">
                    {connection.status === "pending" && connection.incoming ? (
                      <>
                        <BuiButton
                          tone="accent"
                          onClick={() =>
                            void act(() =>
                              rpc.messaging.connections.respond({
                                connectionId: connection.id,
                                accept: true,
                              }),
                            )
                          }
                        >
                          <Trans>Approve</Trans>
                        </BuiButton>
                        <BuiButton
                          onClick={() =>
                            void act(() =>
                              rpc.messaging.connections.respond({
                                connectionId: connection.id,
                                accept: false,
                              }),
                            )
                          }
                        >
                          <Trans>Decline</Trans>
                        </BuiButton>
                      </>
                    ) : null}
                    {connection.status === "approved" ? (
                      <BuiButton
                        onClick={() =>
                          void act(() =>
                            rpc.messaging.connections.revoke({ connectionId: connection.id }),
                          )
                        }
                      >
                        <Trans>Revoke</Trans>
                      </BuiButton>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
