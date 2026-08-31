import { BotAvatar, GroupAvatar, type GroupAvatarMember } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { LoadingState } from "./primitives";

/** Clickable peer bot chip embedded in a Messaged / Message from label. */
export function PeerBotChip({
  ariaLabel,
  color,
  identity,
  botName,
  onClick,
}: {
  ariaLabel: string;
  color: string;
  identity: string;
  botName: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-[#1C1C1F] px-2.5 py-1 text-[13px] text-[#ECECEE] transition-colors hover:bg-[#242428]"
    >
      <BotAvatar color={color} identity={identity} size={16} />
      <span dir="auto" className="truncate">
        {botName}
      </span>
    </button>
  );
}

/** Centered status line with a peer-aware translated label (chip replaces {peer}). */
export function CollaborationMarker({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="peer-receipt-chip"
      className="flex items-center justify-center gap-2 self-center py-1 text-[13.5px] text-[#85858A]"
    >
      {children}
    </div>
  );
}

export function ActiveBotGlyph({ bots, label }: { bots: GroupAvatarMember[]; label: string }) {
  return (
    <div className="flex min-h-10 items-center px-1">
      <LoadingState indicator={<GroupAvatar members={bots} size={28} />} label={label} />
    </div>
  );
}
