import type { BotAvatarSet } from "@rakazo/contracts";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { BotAvatar, Button, GroupAvatar } from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";

/**
 * Lightweight peer event shown without exposing the exchanged message body. `replies` adds a
 * toggle for the peer run's folded replies.
 */
export function CollaborationMarker({
  ariaLabel,
  color,
  avatarSet,
  identity,
  label,
  onClick,
  replies,
}: {
  ariaLabel: string;
  color: string;
  avatarSet?: BotAvatarSet;
  identity: string;
  label: string;
  onClick: () => void;
  replies?: { expanded: boolean; label: string; onToggle: () => void };
}) {
  return (
    <div className="flex min-w-0 max-w-full justify-center">
      <button
        type="button"
        data-testid="peer-receipt-chip"
        aria-label={ariaLabel}
        onClick={onClick}
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground/75"
      >
        <BotAvatar avatarSet={avatarSet} color={color} identity={identity} size={16} />
        <span dir="auto" className="truncate">
          {label}
        </span>
      </button>
      {replies ? (
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="peer-replies-toggle"
          aria-expanded={replies.expanded}
          aria-label={replies.label}
          onClick={replies.onToggle}
          className="ml-1 shrink-0 rounded-full text-muted-foreground"
        >
          <ChevronDown
            size={14}
            strokeWidth={1.8}
            className={
              replies.expanded
                ? "size-3.5 transition-transform"
                : "size-3.5 -rotate-90 transition-transform"
            }
            aria-hidden="true"
          />
        </Button>
      ) : null}
    </div>
  );
}

/** The working bot with what it is doing right now, such as its current tool call. */
export function ActiveBotGlyph({ bots, label }: { bots: GroupAvatarMember[]; label: string }) {
  return (
    <div role="status" className="flex min-h-10 min-w-0 items-center gap-2.5 px-1">
      <GroupAvatar members={bots} size={28} />
      <span dir="auto" className="min-w-0 truncate text-[15px] text-muted-foreground text-shimmer">
        {label}
      </span>
    </div>
  );
}
