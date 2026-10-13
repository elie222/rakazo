import { latestDurableMessageSeq, threadReadAcknowledgement } from "@rakazo/core";
import type { MobileSnapshot } from "./api";

/** Native list viewability supplies the durable rows actually displayed. */
export function mobileVisibleReadSeq(input: {
  snapshot: MobileSnapshot | null;
  visibleIds: ReadonlySet<string>;
  active: boolean;
  focused: boolean;
  ready: boolean;
  readOnly: boolean;
  emptyVisible?: boolean;
}): number | undefined {
  if (!input.active || !input.focused || !input.ready || input.readOnly) return;
  const snapshot = input.snapshot;
  if (!snapshot?.readState) return;
  const throughSeq = latestDurableMessageSeq(
    snapshot.messages.filter((message) => input.visibleIds.has(message.id)),
  );
  return threadReadAcknowledgement(
    snapshot.readState,
    throughSeq ??
      (input.emptyVisible && snapshot.messages.length === 0 && snapshot.olderCursor == null
        ? -1
        : undefined),
  );
}

/** Pinned history uses a ScrollView, whose children all mount even when offscreen. */
export function pinnedVisibleMessageIds(
  layouts: ReadonlyMap<string, { y: number; height: number }>,
  viewport: { offset: number; viewport: number },
  headerHeight: number,
): Set<string> {
  const top = viewport.offset + headerHeight;
  const bottom = viewport.offset + viewport.viewport;
  const ids = new Set<string>();
  if (bottom <= top) return ids;
  for (const [id, row] of layouts) {
    const overlap = Math.min(bottom, row.y + row.height) - Math.max(top, row.y);
    // Tall messages qualify after half a screen; ordinary rows need half their height.
    if (row.height > 0 && overlap >= Math.min(row.height, bottom - top) / 2) ids.add(id);
  }
  return ids;
}
