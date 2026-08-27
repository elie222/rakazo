import { BotAvatar, GroupAvatar, type GroupAvatarMember } from "@rakazo/ui-web";
import type { ReactNode } from "react";

export function CollaborationMarker({
  action,
  ariaLabel,
  color,
  name,
  onClick,
}: {
  action: ReactNode;
  ariaLabel: string;
  color: string;
  name: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className="flex items-center justify-center gap-1.5 self-center rounded-full px-2.5 py-1 text-[13px] text-[#85858A] transition-colors hover:bg-[#161618] hover:text-[#B8B8BD]"
    >
      <span>{action}</span>
      <BotAvatar color={color} size={16} />
      <span dir="auto">{name}</span>
    </button>
  );
}

export function ActiveBotGlyph({ bots, label }: { bots: GroupAvatarMember[]; label: string }) {
  return (
    <div role="status" aria-label={label} className="flex min-h-10 items-center px-1">
      <GroupAvatar members={bots} size={28} />
    </div>
  );
}
