import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { useEventListener } from "../../../lib/use-event-listener";
import type { RosterDropAction, RosterDropSlot, RosterDropTarget } from "./roster-drop";

/** How far a press on a bot moves before it becomes a drag, so a click still opens the chat. */
const DRAG_THRESHOLD_PX = 4;

/** The Space whose sidebar list holds `target`, from the `data-roster-space` on its group. */
export function rosterSpaceAt(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  return target.closest<HTMLElement>("[data-roster-space]")?.dataset.rosterSpace;
}

type Drag = {
  pointerId: number;
  botId: string;
  spaceId: string;
  source: HTMLElement;
  x: number;
  y: number;
  started: boolean;
  /** Escape ended the drag; the press is still held until its release. */
  cancelled: boolean;
  /** The row or header that takes the drop where the pointer is, if any. */
  overKey: string | null;
};

/**
 * Drags a bot in the sidebar with pointer events rather than the browser's native drag, so the
 * page sets the cursor: `grabbing` while moving and `not-allowed` over another Space, where a
 * bot can never go. A bot outside the active Space is read-only here, so it is `not-allowed`
 * everywhere. A native drag lets the browser draw its own cursor and ignores CSS.
 * Returns the handler a bot row calls on pointer down.
 */
export function useRosterPointerDrag(options: {
  slots: ReadonlyMap<string, RosterDropSlot>;
  activeSpaceId: string | undefined;
  setDraggedBotId: (id: string | null) => void;
  setRosterDropKey: (key: string | null) => void;
  rosterDropAction: (target: RosterDropTarget, sameList: boolean) => RosterDropAction | null;
  applyRosterDrop: (target: RosterDropTarget, sameList: boolean, botIds: string[]) => void;
}) {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const drag = useRef<Drag | null>(null);
  const swallowClick = useRef(false);

  const hover = (current: Drag) => {
    const under = document.elementFromPoint(current.x, current.y);
    const spaceId = rosterSpaceAt(under);
    const refused =
      current.spaceId !== latest.current.activeSpaceId ||
      (spaceId !== undefined && spaceId !== current.spaceId);
    document.documentElement.dataset.rosterDrag = refused ? "refused" : "moving";
    const key =
      under?.closest<HTMLElement>("[data-roster-drop-key]")?.dataset.rosterDropKey ?? null;
    const slot = key ? latest.current.slots.get(key) : undefined;
    const accepted =
      !refused &&
      slot?.target &&
      latest.current.rosterDropAction(slot.target, sameList(slot, current))
        ? key
        : null;
    if (accepted === current.overKey) return;
    current.overKey = accepted;
    latest.current.setRosterDropKey(accepted);
  };

  /** Stops showing the drag: the cursor, the dimmed bot and the highlighted target. */
  const clearShown = () => {
    delete document.documentElement.dataset.rosterDrag;
    latest.current.setDraggedBotId(null);
    latest.current.setRosterDropKey(null);
  };

  /** Lets go of the press without a release that ends in a click, so nothing is dropped. */
  const abort = () => {
    const current = drag.current;
    drag.current = null;
    if (!current?.started) return;
    releaseCapture(current);
    if (!current.cancelled) clearShown();
  };

  const release = () => {
    const current = drag.current;
    drag.current = null;
    if (!current?.started) return;
    releaseCapture(current);
    // The release ends in a click on the row the drag started from, which must not open it.
    swallowClick.current = true;
    if (current.cancelled) return;
    const slot = current.overKey ? latest.current.slots.get(current.overKey) : undefined;
    if (!slot?.target) {
      clearShown();
      return;
    }
    delete document.documentElement.dataset.rosterDrag;
    latest.current.applyRosterDrop(slot.target, sameList(slot, current), slot.groupBotIds);
  };

  useEventListener(window, "pointermove", (event) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    // The release happened where the page could not see it, such as outside the window.
    if ((event.buttons & 1) === 0) {
      abort();
      return;
    }
    if (current.cancelled) return;
    if (!current.started) {
      const moved = Math.hypot(event.clientX - current.x, event.clientY - current.y);
      if (moved < DRAG_THRESHOLD_PX) return;
      current.started = true;
      // Keep the pointer's events after it leaves the window, so a release there ends the drag.
      current.source.setPointerCapture(current.pointerId);
      window.getSelection()?.removeAllRanges();
      // Render the drag now, so this same move is judged against the dragged bot.
      flushSync(() => latest.current.setDraggedBotId(current.botId));
    }
    current.x = event.clientX;
    current.y = event.clientY;
    hover(current);
  });
  useEventListener(window, "pointerup", (event) => {
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) return;
    // Judge the drop where the pointer is released; no move may have reported that spot.
    if (current.started && !current.cancelled) {
      current.x = event.clientX;
      current.y = event.clientY;
      hover(current);
    }
    release();
  });
  useEventListener(window, "pointercancel", (event) => {
    if (drag.current?.pointerId === event.pointerId) abort();
  });
  useEventListener(window, "blur", abort);
  useEventListener(window, "keydown", (event) => {
    const current = drag.current;
    if (event.key !== "Escape" || !current?.started || current.cancelled) return;
    event.preventDefault();
    current.cancelled = true;
    clearShown();
  });
  // Scrolling the list under a still pointer changes what it is over.
  useEventListener(
    window,
    "scroll",
    () => {
      if (drag.current?.started && !drag.current.cancelled) hover(drag.current);
    },
    { capture: true, passive: true },
  );
  // Only the click that ends a drag is swallowed: any later press or key clears the flag, in
  // case that click never came (a release outside the window, say).
  const clearSwallow = () => {
    swallowClick.current = false;
  };
  useEventListener(window, "pointerdown", clearSwallow, true);
  useEventListener(window, "keydown", clearSwallow, true);
  useEventListener(
    window,
    "click",
    (event) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  // The roster can give way mid-drag (to search results, say). The dragged bot and target
  // live in the parent, so clear them too, or the bot stays dimmed when the roster returns.
  useEffect(
    () => () => {
      const current = drag.current;
      drag.current = null;
      if (!current?.started || current.cancelled) return;
      delete document.documentElement.dataset.rosterDrag;
      latest.current.setDraggedBotId(null);
      latest.current.setRosterDropKey(null);
    },
    [],
  );

  return (event: ReactPointerEvent<HTMLElement>, bot: { id: string; spaceId: string }) => {
    // Touch keeps scrolling the list; the chat menu's Move to still moves bots there.
    if (event.button !== 0 || event.pointerType === "touch" || event.ctrlKey || event.metaKey) {
      return;
    }
    drag.current = {
      pointerId: event.pointerId,
      botId: bot.id,
      spaceId: bot.spaceId,
      source: event.currentTarget,
      x: event.clientX,
      y: event.clientY,
      started: false,
      cancelled: false,
      overKey: null,
    };
  };
}

function sameList(slot: RosterDropSlot, current: Drag): boolean {
  return !slot.header && slot.groupBotIds.includes(current.botId);
}

function releaseCapture(current: Drag) {
  if (current.source.hasPointerCapture(current.pointerId)) {
    current.source.releasePointerCapture(current.pointerId);
  }
}
