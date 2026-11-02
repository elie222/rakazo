import { useEffect } from "react";
import type { RakazoDesktop } from "./desktop";
import { desktopBridge } from "./desktop";

type Badge = NonNullable<RakazoDesktop["badge"]>;
type BadgeSource = "accounts" | "roster";
type BadgeState = {
  counts: Partial<Record<BadgeSource, number | undefined>>;
  lastCount?: number;
  scheduled: boolean;
};
const bridges = new WeakMap<Badge, BadgeState>();

/** The account total owns the badge; older APIs use the mounted shell's roster instead. */
function updateBadge(badge: Badge, source: BadgeSource, count: number | undefined): void {
  let state = bridges.get(badge);
  if (!state) {
    state = { counts: {}, scheduled: false };
    bridges.set(badge, state);
  }
  state.counts[source] = count;
  if (state.scheduled) return;
  state.scheduled = true;
  const pending = state;
  // React updates child and parent effects separately; publish their completed handoff once.
  queueMicrotask(() => {
    pending.scheduled = false;
    const next = pending.counts.accounts ?? pending.counts.roster ?? 0;
    if (pending.lastCount === next) return;
    pending.lastCount = next;
    void badge.set(next).catch(() => undefined);
  });
}

export function useDesktopBadge(count: number | undefined, source: BadgeSource = "accounts") {
  const badge = desktopBridge()?.badge;
  useEffect(() => {
    return () => {
      if (badge) updateBadge(badge, source, undefined);
    };
  }, [badge, source]);
  useEffect(() => {
    if (badge) updateBadge(badge, source, count);
  }, [badge, count, source]);
}
