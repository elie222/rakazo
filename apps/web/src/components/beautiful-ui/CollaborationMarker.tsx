import { BotAvatar, GroupAvatar, type GroupAvatarMember } from "@rakazo/ui-web";
import { LoadingState } from "./primitives";

/** Centered status line: "Messaged" / "Message from" plus a clickable bot chip. */
export function CollaborationMarker({
  ariaLabel,
  color,
  identity,
  prefix,
  botName,
  onClick,
}: {
  ariaLabel: string;
  color: string;
  identity: string;
  prefix: string;
  botName: string;
  onClick: () => void;
}) {
  return (
    <div
      data-testid="peer-receipt-chip"
      className="flex items-center justify-center gap-2 self-center py-1 text-[13.5px] text-[#85858A]"
    >
      <span>{prefix}</span>
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
