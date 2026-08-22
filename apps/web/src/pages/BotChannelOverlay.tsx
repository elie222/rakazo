import type { BotChannel } from "@rakazo/contracts";
import { formatChatTimestamp, shouldShowChatTimestamp } from "@rakazo/core";
import { BotAvatar } from "@rakazo/ui-web";
import { Link2, Lock, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";

export function BotChannelOverlay({
  botId,
  peerBotId,
  onClose,
}: {
  botId: string;
  peerBotId: string;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [channel, setChannel] = useState<BotChannel | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);
  useEffect(() => {
    let cancelled = false;
    setChannel(null);
    setError(null);
    void rpc.threads
      .channel({ botId, peerBotId })
      .then((next) => {
        if (!cancelled) setChannel(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not open chat");
      });
    return () => {
      cancelled = true;
    };
  }, [botId, peerBotId]);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [channel?.messages.length]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bot-channel-title"
      aria-busy={!channel && !error}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      className="absolute inset-0 z-40 flex flex-col bg-[#0D0D0E]"
    >
      <div className="flex items-center justify-between border-b border-[#141416] px-5 py-3.5">
        <div
          id="bot-channel-title"
          className="flex min-w-0 items-center gap-2.5 text-[15px] font-medium text-[#ECECEE]"
        >
          {channel ? (
            <>
              <span className="truncate">{channel.left.name}</span>
              <Link2 size={14} strokeWidth={2} className="shrink-0 text-[#6C6C70]" />
              <span className="truncate">{channel.right.name}</span>
            </>
          ) : (
            <span className="font-normal text-[#85858A]">Opening chat…</span>
          )}
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          aria-label="Close chat"
          onClick={onClose}
          className="grid h-8 w-8 place-items-center rounded-[9px] text-[#85858A] hover:bg-[#1B1B1E] hover:text-[#ECECEE]"
        >
          <X size={16} />
        </button>
      </div>
      <div ref={scrollRef} className="rk-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error ? (
          <div role="alert" className="py-10 text-center text-[14px] text-[#85858A]">
            {error}
          </div>
        ) : null}
        {channel && channel.messages.length === 0 && !error ? (
          <div className="py-16 text-center text-[14px] text-[#6C6C70]">No messages yet.</div>
        ) : null}
        {channel?.messages.map((entry, index) => {
          const from = entry.fromBotId === channel.left.id ? channel.left : channel.right;
          return (
            <div key={entry.id}>
              {shouldShowChatTimestamp(channel.messages[index - 1]?.createdAt, entry.createdAt) ? (
                <div className="py-3 text-center text-[12.5px] text-[#6C6C70]">
                  {formatChatTimestamp(entry.createdAt)}
                </div>
              ) : null}
              <div className="mb-3.5 flex items-start gap-2.5">
                <BotAvatar color={from.color} size={28} />
                <div className="min-w-0 max-w-[min(420px,82%)]">
                  <div className="mb-1 text-[13px] text-[#8E8EA0]">{from.name}</div>
                  <div className="rounded-[18px] bg-[#1A1A1D] px-4 py-2.5 text-[15px] leading-[1.5] text-[#DFDFE2]">
                    {entry.text}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-[#141416] px-5 py-3.5">
        <div className="flex items-center gap-2 text-[13.5px] text-[#85858A]">
          <Lock size={13} />
          This chat is view-only
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-[10px] bg-[#F1F1EF] px-3.5 py-1.5 text-[13.5px] font-medium text-[#17171A]"
        >
          Close Chat
        </button>
      </div>
    </div>
  );
}
