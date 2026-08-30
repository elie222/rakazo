import { Trans, useLingui } from "@lingui/react/macro";
import type { PhoneAgentConnection, PhoneChannelMembership, PhoneStatus } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { BuiButton } from "../components/beautiful-ui/primitives";
import { rpc } from "../lib/rpc";

export function PhoneSettingsOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [channels, setChannels] = useState<PhoneChannelMembership[]>([]);
  const [connections, setConnections] = useState<PhoneAgentConnection[]>([]);
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
    const [nextStatus, nextChannels, nextConnections] = await Promise.all([
      rpc.phone.status(),
      rpc.phone.channels.list(),
      rpc.phone.connections.list(),
    ]);
    setStatus(nextStatus);
    setChannels(nextChannels);
    setConnections(nextConnections);
  }

  useEffect(() => {
    void refresh().catch(() => setError(t`Couldn't load phone settings`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await refresh();
    } catch {
      setError(t`Couldn't update phone settings`);
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgba(4,4,5,.62)] p-4 sm:p-10">
      <div
        ref={panelRef}
        data-testid="phone-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="phone-settings-title"
        tabIndex={-1}
        className="rk-scroll max-h-full w-[640px] max-w-full overflow-y-auto rounded-[26px] border border-[#232326] bg-[#141416] p-6 shadow-[0_40px_90px_rgba(0,0,0,.55)] sm:p-8"
      >
        <div className="flex items-start justify-between gap-6">
          <h2 id="phone-settings-title" className="text-2xl font-medium text-[#F1F1F2]">
            <Trans>Phone</Trans>
          </h2>
          <button
            type="button"
            aria-label={t`Close phone settings`}
            onClick={onClose}
            className="text-[#85858A]"
          >
            ✕
          </button>
        </div>

        {error ? <p className="mt-4 text-[13px] text-[#E88B8B]">{error}</p> : null}

        <section className="mt-8 rounded-[14px] border border-[#26262A] bg-[#101012] px-4 py-4">
          <h3 className="text-[15px] font-medium text-[#ECECEE]">
            <Trans>iMessage line</Trans>
          </h3>
          <p className="mt-3 text-[14px] text-[#C9C9CE]">
            {status?.linked ? (
              <Trans>Linked as {status.phoneE164}</Trans>
            ) : (
              <Trans>
                Not linked — text the deployment's number once to link your phone to your agent.
              </Trans>
            )}
          </p>
        </section>

        <section className="mt-5 rounded-[14px] border border-[#26262A] bg-[#101012] px-4 py-4">
          <h3 className="text-[15px] font-medium text-[#ECECEE]">
            <Trans>Channels</Trans>
          </h3>
          {channels.length === 0 ? (
            <p className="mt-3 text-[13px] text-[#7A7A80]">
              <Trans>No iMessage groups yet.</Trans>
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {channels.map((channel) => (
                <li
                  key={channel.channelId}
                  className="flex items-center justify-between gap-3 text-[14px] text-[#C9C9CE]"
                >
                  <span>
                    {channel.name ?? t`Group`}{" "}
                    <span className="text-[12px] text-[#7A7A80]">
                      {channel.status} · {channel.memberCount}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    {channel.status === "invited" ? (
                      <>
                        <BuiButton
                          tone="accent"
                          onClick={() =>
                            void act(() =>
                              rpc.phone.channels.respond({
                                channelId: channel.channelId,
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
                              rpc.phone.channels.respond({
                                channelId: channel.channelId,
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
                          void act(() => rpc.phone.channels.leave({ channelId: channel.channelId }))
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

        <section className="mt-5 rounded-[14px] border border-[#26262A] bg-[#101012] px-4 py-4">
          <h3 className="text-[15px] font-medium text-[#ECECEE]">
            <Trans>Agent connections</Trans>
          </h3>
          {connections.length === 0 ? (
            <p className="mt-3 text-[13px] text-[#7A7A80]">
              <Trans>No agent connections yet.</Trans>
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {connections.map((connection) => (
                <li
                  key={connection.id}
                  className="flex items-center justify-between gap-3 text-[14px] text-[#C9C9CE]"
                >
                  <span>
                    {connection.peerOwnerLabel}
                    {"'s "}
                    {connection.peerBotName}{" "}
                    <span className="text-[12px] text-[#7A7A80]">{connection.status}</span>
                  </span>
                  <span className="flex gap-2">
                    {connection.status === "pending" && connection.incoming ? (
                      <>
                        <BuiButton
                          tone="accent"
                          onClick={() =>
                            void act(() =>
                              rpc.phone.connections.respond({
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
                              rpc.phone.connections.respond({
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
                            rpc.phone.connections.revoke({ connectionId: connection.id }),
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
