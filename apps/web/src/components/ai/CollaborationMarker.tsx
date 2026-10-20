import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { BotAvatar, Button, GroupAvatar, type GroupAvatarMember } from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { LoadingState } from "./primitives";

/**
 * Compact peer event. `detail` reveals an exchanged message on demand; `replies` controls
 * the peer run's folded replies.
 */
export function CollaborationMarker({
  ariaLabel,
  color,
  identity,
  label,
  onClick,
  replies,
  detail,
}: {
  ariaLabel: string;
  color: string;
  identity: string;
  label: string;
  onClick: () => void;
  replies?: { expanded: boolean; label: string; onToggle: () => void };
  detail?: { text: string; expandLabel: string; collapseLabel: string };
}) {
  const [detailExpanded, setDetailExpanded] = useState(false);
  const disclosure = detail?.text.trim()
    ? {
        expanded: detailExpanded,
        label: detailExpanded ? detail.collapseLabel : detail.expandLabel,
        onToggle: () => setDetailExpanded((expanded) => !expanded),
      }
    : replies;
  return (
    <>
      <div className="flex justify-start">
        <button
          type="button"
          data-testid="peer-receipt-chip"
          aria-label={ariaLabel}
          onClick={onClick}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground/75"
        >
          <BotAvatar color={color} identity={identity} size={16} />
          <span dir="auto" className="truncate">
            {label}
          </span>
        </button>
        {disclosure ? (
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="peer-replies-toggle"
            aria-expanded={disclosure.expanded}
            aria-label={disclosure.label}
            onClick={disclosure.onToggle}
            className="rounded-full text-muted-foreground"
          >
            <ChevronDown
              size={14}
              strokeWidth={1.8}
              className={
                disclosure.expanded
                  ? "size-3.5 transition-transform"
                  : "size-3.5 -rotate-90 transition-transform"
              }
              aria-hidden="true"
            />
          </Button>
        ) : null}
      </div>
      {detailExpanded && detail?.text.trim() ? (
        <div
          data-testid="peer-message-detail"
          className="mt-1 w-fit min-w-0 max-w-[88%] rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90"
          dir="auto"
        >
          <ChatMarkdown compact>{detail.text}</ChatMarkdown>
        </div>
      ) : null}
    </>
  );
}

export function ActiveBotGlyph({ bots, label }: { bots: GroupAvatarMember[]; label: string }) {
  return (
    <div className="flex min-h-10 items-center px-1">
      <LoadingState indicator={<GroupAvatar members={bots} size={28} />} label={label} />
    </div>
  );
}
