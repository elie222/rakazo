import type { BotAvatarSet } from "@rakazo/contracts";
import { splitPeerLabel } from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { BotAvatar, GroupAvatar, resolvePersonaColorDef } from "@rakazo/ui-web";

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
    <div className="flex min-w-0 max-w-full justify-center py-1">
      <button
        type="button"
        data-testid="peer-receipt-chip"
        aria-label={label}
        onClick={onClick}
        className="inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground/75 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        {parts.before ? <span className="whitespace-pre-wrap">{parts.before}</span> : null}
        <BotAvatar avatarSet={avatarSet} color={color} identity={identity} size={16} />
        {parts.name ? (
          // The bot's own colour marks its name, as it does in message mentions.
          <span
            dir="auto"
            className="truncate font-medium"
            style={{ color: resolvePersonaColorDef(identity, color).hex }}
          >
            {parts.name}
          </span>
        ) : null}
        {parts.after ? <span className="whitespace-pre-wrap">{parts.after}</span> : null}
      </button>
    </div>
  );
}

/**
 * One status row while bots work, walking from "Working…" through each live activity line to
 * "Typing…" once the reply is being written. The working bots' faces hop beside it (a photo
 * avatar bounces instead); three soft dots stand in when no bot is known yet. Each new line
 * slides in, with a light sweeping across it.
 */
export function ActiveBotGlyph({ bots, label }: { bots: GroupAvatarMember[]; label: string }) {
  return (
    <div role="status" className="flex min-h-7 min-w-0 items-center gap-2 px-0.5">
      {bots.length > 0 ? (
        <GroupAvatar members={bots} size={24} motionPriority />
      ) : (
        <span
          aria-hidden="true"
          data-testid="typing-dots"
          className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-muted px-[9px]"
        >
          {[0, 160, 320].map((delay) => (
            <span
              key={delay}
              className="size-[5px] rounded-full bg-muted-foreground motion-safe:animate-typing-dot"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
      )}
      <span
        key={label}
        dir="auto"
        className="min-w-0 truncate text-body1 text-shimmer motion-safe:animate-status-label"
      >
        {label}
      </span>
    </div>
  );
}
