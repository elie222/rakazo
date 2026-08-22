import type { BotChannel } from "@rakazo/contracts";
import { BotAvatar } from "@rakazo/ui-web";
import { Link2, Lock, X } from "lucide-react";
import { useEffect, useState } from "react";
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
  const [channel, setChannel] = useState<BotChannel | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-[#0D0D0E]">
      <div className="flex items-center justify-between border-b border-[#141416] px-5 py-4">
        <div className="flex min-w-0 items-center gap-2.5">
          {channel ? (
            <>
              <BotAvatar color={channel.left.color} size={22} />
              <span className="truncate text-[15px] font-medium text-[#ECECEE]">
                {channel.left.name}
              </span>
              <Link2 size={14} className="shrink-0 text-[#6C6C70]" />
              <BotAvatar color={channel.right.color} size={22} />
              <span className="truncate text-[15px] font-medium text-[#ECECEE]">
                {channel.right.name}
              </span>
            </>
          ) : (
            <span className="text-[15px] text-[#85858A]">Opening chat…</span>
          )}
        </div>
        <button
          type="button"
          aria-label="Close chat"
          onClick={onClose}
          className="grid h-8 w-8 place-items-center rounded-[9px] text-[#85858A] hover:bg-[#1B1B1E] hover:text-[#ECECEE]"
        >
          <X size={16} />
        </button>
      </div>
      <div className="rk-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
        {error ? <div className="text-center text-[14px] text-[#85858A]">{error}</div> : null}
        {channel && channel.messages.length === 0 ? (
          <div className="text-center text-[14px] text-[#6C6C70]">No messages yet.</div>
        ) : null}
        {channel?.messages.map((entry) => {
          const from = entry.fromBotId === channel.left.id ? channel.left : channel.right;
          return (
            <div key={entry.id} className="flex items-start gap-2.5">
              <BotAvatar color={from.color} size={22} />
              <div className="min-w-0">
                <div className="mb-1 text-[13px] text-[#8E8EA0]">{from.name}</div>
                <div className="rounded-[18px] bg-[#1A1A1D] px-4 py-2.5 text-[15px] leading-[1.5] text-[#DFDFE2]">
                  {entry.text}
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
