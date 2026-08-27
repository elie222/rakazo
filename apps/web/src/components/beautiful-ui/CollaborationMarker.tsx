import { BotAvatar, GroupAvatar, type GroupAvatarMember } from "@rakazo/ui-web";
import { LoadingState } from "./primitives";

export function CollaborationMarker({
  ariaLabel,
  color,
  identity,
  label,
  onClick,
}: {
  ariaLabel: string;
  color: string;
  identity: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className="flex items-center justify-center gap-1.5 self-center rounded-full px-2.5 py-1 text-[13px] text-[#85858A] transition-colors hover:bg-[#161618] hover:text-[#B8B8BD]"
    >
      <BotAvatar color={color} identity={identity} size={16} />
      <span dir="auto">{label}</span>
    </button>
  );
}

export function ActiveBotGlyph({ bots, label }: { bots: GroupAvatarMember[]; label: string }) {
  return (
    <div className="flex min-h-10 items-center px-1">
      <LoadingState indicator={<GroupAvatar members={bots} size={28} />} label={label} />
    </div>
  );
}
