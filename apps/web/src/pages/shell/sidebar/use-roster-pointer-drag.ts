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
  /** The row or header that takes the drop where the pointer is, if any. */
  overKey: string | null;
};

/**
 * Drags a bot in the sidebar with pointer events rather than the browser's native drag, so the
 * page sets the cursor: `grabbing` while moving and `not-allowed` over another Space, where a
 * bot can never go. A native drag lets the browser draw its own cursor and ignores CSS.
 * Returns the handler a bot row calls on pointer down.
 */
export function useRosterPointerDrag(options: {
  slots: ReadonlyMap<string, RosterDropSlot>;
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
    document.documentElement.dataset.rosterDrag =
      spaceId && spaceId !== current.spaceId ? "refused" : "moving";
    const key =
      under?.closest<HTMLElement>("[data-roster-drop-key]")?.dataset.rosterDropKey ?? null;
    const slot = key ? latest.current.slots.get(key) : undefined;
    const accepted =
      slot?.target && latest.current.rosterDropAction(slot.target, sameList(slot, current))
        ? key
        : null;
    if (accepted === current.overKey) return;
    current.overKey = accepted;
    latest.current.setRosterDropKey(accepted);
  };

  const finish = (drop: boolean) => {
    const current = drag.current;
    drag.current = null;
    if (!current?.started) return;
    if (current.source.hasPointerCapture(current.pointerId)) {
      current.source.releasePointerCapture(current.pointerId);
    }
    delete document.documentElement.dataset.rosterDrag;
    swallowClick.current = true;
    const slot = drop && current.overKey ? latest.current.slots.get(current.overKey) : undefined;
    if (slot?.target) {
      latest.current.applyRosterDrop(slot.target, sameList(slot, current), slot.groupBotIds);
      return;
    }
    latest.current.setDraggedBotId(null);
    latest.current.setRosterDropKey(null);
  };

  useEventListener(window, "pointermove", (event) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
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
    if (drag.current?.pointerId === event.pointerId) finish(true);
  });
  useEventListener(window, "pointercancel", (event) => {
    if (drag.current?.pointerId === event.pointerId) finish(false);
  });
  useEventListener(window, "keydown", (event) => {
    if (event.key !== "Escape" || !drag.current?.started) return;
    event.preventDefault();
    finish(false);
  });
  useEventListener(window, "blur", () => finish(false));
  // Scrolling the list under a still pointer changes what it is over.
  useEventListener(
    window,
    "scroll",
    () => {
      if (drag.current?.started) hover(drag.current);
    },
    { capture: true, passive: true },
  );
  // A drag ends with a click on the row it started from, which must not open that chat. Any
  // later press clears the flag, in case no click came.
  useEventListener(
    window,
    "pointerdown",
    () => {
      swallowClick.current = false;
    },
    true,
  );
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
  // Leaving mid-drag must not leave the page's cursor behind.
  useEffect(
    () => () => {
      if (drag.current?.started) delete document.documentElement.dataset.rosterDrag;
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
      overKey: null,
    };
  };
}

function sameList(slot: RosterDropSlot, current: Drag): boolean {
  return !slot.header && slot.groupBotIds.includes(current.botId);
}
