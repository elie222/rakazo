import type { BotAvatarSet } from "@rakazo/contracts";
import { splitPeerLabel } from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { BotAvatar, GroupAvatar } from "@rakazo/ui-web";
import type { ReactNode } from "react";

export interface AvatarStackBot {
  botId: string;
  name: string;
  color: string;
  avatarSet?: BotAvatarSet;
}

/** Overlapping horizontal row of bot avatars for compact single-line peer activity rows. */
export function BotAvatarStack({
  bots,
  size = 18,
}: {
  bots: readonly AvatarStackBot[];
  size?: number;
}) {
  const visible = bots.slice(0, 4);
  if (visible.length === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center -space-x-1.5" aria-hidden="true">
      {visible.map((bot) => (
        <span key={bot.botId} className="inline-flex rounded-full ring-2 ring-background">
          <BotAvatar avatarSet={bot.avatarSet} color={bot.color} identity={bot.botId} size={size} />
        </span>
      ))}
    </span>
  );
}

/** Centered single-line disclosure chip matching "Messaged [avatars] N Bots". */
export function MultiBotCollaborationMarker({
  prefix,
  suffix,
  bots,
  ariaLabel,
  expanded,
  onToggle,
  testId = "peer-group-chip",
  children,
}: {
  prefix?: string;
  suffix: string;
  bots: readonly AvatarStackBot[];
  ariaLabel?: string;
  expanded: boolean;
  onToggle: () => void;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 max-w-full flex-col items-center">
      <button
        type="button"
        data-testid={testId}
        aria-expanded={expanded}
        aria-label={ariaLabel ?? (prefix ? `${prefix} ${suffix}` : suffix)}
        onClick={onToggle}
        className="inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1.5 text-body-sm text-muted-foreground transition-colors hover:text-foreground/80 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        {prefix ? <span className="shrink-0">{prefix}</span> : null}
        <BotAvatarStack bots={bots} />
        <span dir="auto" className="truncate font-medium">
          {suffix}
        </span>
      </button>
      {expanded ? children : null}
    </div>
  );
}

export function CollaborationMarker({
  color,
  avatarSet,
  identity,
  label,
  peerName,
  onClick,
}: {
  color: string;
  avatarSet?: BotAvatarSet;
  identity: string;
  label: string;
  peerName: string;
  onClick: () => void;
}) {
  const parts = splitPeerLabel(label, peerName);
  return (
    <div className="flex min-w-0 max-w-full justify-center">
      <button
        type="button"
        data-testid="peer-receipt-chip"
        aria-label={label}
        onClick={onClick}
        className="inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-body-sm text-muted-foreground transition-colors hover:text-foreground/75 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        {parts.before ? <span className="whitespace-pre-wrap">{parts.before}</span> : null}
        <BotAvatar avatarSet={avatarSet} color={color} identity={identity} size={16} />
        {parts.name ? (
          <span dir="auto" className="truncate font-medium">
            {parts.name}
          </span>
        ) : null}
        {parts.after ? <span className="whitespace-pre-wrap">{parts.after}</span> : null}
      </button>
    </div>
  );
}

/** The working bot with what it is doing right now, such as its current tool call. */
export function ActiveBotGlyph({ bots, label }: { bots: GroupAvatarMember[]; label: string }) {
  return (
    <div role="status" className="flex min-h-10 min-w-0 items-center gap-2.5 px-1">
      <GroupAvatar members={bots} size={28} />
      <span
        key={label}
        dir="auto"
        className="block min-w-0 truncate text-body-lg text-muted-foreground animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:animate-none"
      >
        <span className="text-shimmer">{label}</span>
      </span>
    </div>
  );
}
