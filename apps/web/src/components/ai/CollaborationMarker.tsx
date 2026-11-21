import type { BotAvatarSet } from "@rakazo/contracts";
import { splitPeerLabel } from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { BotAvatar, GroupAvatar } from "@rakazo/ui-web";
import { useState } from "react";

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

/**
 * The working bot with what it is doing right now, such as its current tool call. The line
 * fades in a beat after it appears, and each new label cross-fades over the last in place.
 */
export function ActiveBotGlyph({ bots, label }: { bots: GroupAvatarMember[]; label: string }) {
  return (
    <div
      role="status"
      className="flex min-h-10 min-w-0 items-center gap-2.5 px-1 motion-safe:animate-[rk-fade-in_300ms_ease-out_150ms_both]"
    >
      <GroupAvatar members={bots} size={28} />
      <CrossFadeLabel label={label} />
    </div>
  );
}

function CrossFadeLabel({ label }: { label: string }) {
  const [shown, setShown] = useState<{ label: string; previous: string | null }>({
    label,
    previous: null,
  });
  if (shown.label !== label) setShown({ label, previous: shown.label });
  // Both labels share one grid cell, so the swap never moves the line.
  return (
    <span className="grid min-w-0">
      {shown.previous !== null ? (
        <span
          key={`out:${shown.previous}`}
          aria-hidden="true"
          className="col-start-1 row-start-1 min-w-0 motion-safe:animate-[rk-fade-out_200ms_ease-out_both] motion-reduce:hidden"
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) {
              setShown((current) => ({ ...current, previous: null }));
            }
          }}
        >
          <WorkingLabelText text={shown.previous} />
        </span>
      ) : null}
      <span
        key={`in:${shown.label}`}
        className="col-start-1 row-start-1 min-w-0 motion-safe:animate-[rk-fade-in_200ms_ease-out_both]"
      >
        <WorkingLabelText text={shown.label} />
      </span>
    </span>
  );
}

function WorkingLabelText({ text }: { text: string }) {
  return (
    <span dir="auto" className="block truncate text-body-lg text-muted-foreground text-shimmer">
      {text}
    </span>
  );
}
