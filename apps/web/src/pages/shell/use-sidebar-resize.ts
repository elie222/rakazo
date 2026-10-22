import type { HTMLAttributes, PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import {
  BOTS_SIDEBAR_MIN_WIDTH,
  BOTS_SIDEBAR_MINI_WIDTH,
  BOTS_SIDEBAR_SNAP_WIDTH,
  clampBotsSidebarWidth,
  maximumBotsSidebarWidth,
  readBotsSidebarWidth,
  writeBotsSidebarWidth,
} from "../../lib/bots-sidebar-pref";

function direction() {
  return document.documentElement.dir === "rtl" ? -1 : 1;
}

export function useSidebarResize({
  userId,
  collapsed,
  onCollapsedChange,
}: {
  userId: string | null | undefined;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const [preferredWidth, setPreferredWidth] = useState(() => readBotsSidebarWidth(userId));
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    width: number;
    direction: number;
    moved: boolean;
  } | null>(null);
  const maxWidth = maximumBotsSidebarWidth(viewportWidth);
  const expandedWidth = clampBotsSidebarWidth(preferredWidth, viewportWidth);
  const width =
    dragWidth !== null
      ? Math.min(maxWidth, dragWidth)
      : collapsed
        ? BOTS_SIDEBAR_MINI_WIDTH
        : expandedWidth;

  useEffect(() => {
    setPreferredWidth(readBotsSidebarWidth(userId));
    drag.current = null;
    setDragWidth(null);
  }, [userId]);

  useEffect(() => {
    function resize() {
      setViewportWidth(window.innerWidth);
    }
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  function commit(next: number) {
    if (next < BOTS_SIDEBAR_SNAP_WIDTH) {
      onCollapsedChange(true);
      return;
    }
    const expanded = clampBotsSidebarWidth(next, window.innerWidth);
    setPreferredWidth(expanded);
    writeBotsSidebarWidth(userId, expanded);
    onCollapsedChange(false);
  }

  function release(event: PointerEvent<HTMLElement>) {
    drag.current = null;
    setDragWidth(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function widthAt(clientX: number) {
    const current = drag.current;
    if (!current) return width;
    return Math.max(
      BOTS_SIDEBAR_MINI_WIDTH,
      Math.min(
        maximumBotsSidebarWidth(window.innerWidth),
        current.width + (clientX - current.startX) * current.direction,
      ),
    );
  }

  const handleProps: HTMLAttributes<HTMLElement> = {
    role: "separator",
    tabIndex: 0,
    "aria-orientation": "vertical",
    "aria-valuemin": BOTS_SIDEBAR_MINI_WIDTH,
    "aria-valuemax": maxWidth,
    "aria-valuenow": Math.round(width),
    onPointerDown(event) {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        width,
        direction: direction(),
        moved: false,
      };
      setDragWidth(width);
    },
    onPointerMove(event) {
      if (drag.current?.pointerId !== event.pointerId) return;
      if (Math.abs(event.clientX - drag.current.startX) >= 4) drag.current.moved = true;
      setDragWidth(widthAt(event.clientX));
    },
    onPointerUp(event) {
      if (drag.current?.pointerId !== event.pointerId) return;
      if (!drag.current.moved && Math.abs(event.clientX - drag.current.startX) < 4)
        onCollapsedChange(!collapsed);
      else commit(widthAt(event.clientX));
      release(event);
    },
    onPointerCancel(event) {
      if (drag.current?.pointerId === event.pointerId) release(event);
    },
    onLostPointerCapture(event) {
      if (drag.current?.pointerId !== event.pointerId) return;
      drag.current = null;
      setDragWidth(null);
    },
    onKeyDown(event) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const step = (event.key === "ArrowRight" ? 32 : -32) * direction();
        const next = width + step;
        commit(
          step < 0 && next < BOTS_SIDEBAR_MIN_WIDTH
            ? BOTS_SIDEBAR_MINI_WIDTH
            : next < BOTS_SIDEBAR_SNAP_WIDTH && step > 0
              ? BOTS_SIDEBAR_MIN_WIDTH
              : next,
        );
      } else if (event.key === "Home") {
        event.preventDefault();
        commit(BOTS_SIDEBAR_MINI_WIDTH);
      } else if (event.key === "End") {
        event.preventDefault();
        commit(maxWidth);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onCollapsedChange(!collapsed);
      }
    },
  };

  return {
    width,
    resizing: dragWidth !== null,
    handleProps,
  };
}
