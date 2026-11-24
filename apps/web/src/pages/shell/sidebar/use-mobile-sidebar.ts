import type { TouchEvent } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEventListener } from "../../../lib/use-event-listener";
import { isComposingKey } from "../shell-shortcuts";

const MOBILE_SIDEBAR_SWIPE_EDGE_PX = 32;
const MOBILE_SIDEBAR_SWIPE_DISTANCE_PX = 56;

function isDesktop() {
  return window.matchMedia("(min-width: 768px)").matches;
}

function isRtl() {
  return document.documentElement.getAttribute("dir") === "rtl";
}

/** The phone sidebar drawer, opened by its button or a swipe in from the leading edge. */
export function useMobileSidebar() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!mobileSidebarOpen && restoreFocus.current) {
      restoreFocus.current = false;
      const trigger = document.querySelector<HTMLButtonElement>("[data-navigation-trigger]");
      const computerClose = document.querySelector<HTMLButtonElement>("[data-computer-close]");
      const target =
        computerClose ??
        (trigger?.closest("[inert]")
          ? document.querySelector<HTMLElement>('aside[data-panel]:not([data-panel="closed"])')
          : trigger);
      target?.focus({ preventScroll: true });
    }
  }, [mobileSidebarOpen]);
  const swipeRef = useRef<{ startX: number; startY: number } | null>(null);

  const [desktop] = useState(() => window.matchMedia("(min-width: 768px)"));
  const closeMobileSidebar = () => {
    if (desktop.matches) setMobileSidebarOpen(false);
  };
  useEffect(closeMobileSidebar, []);
  useEventListener(desktop, "change", closeMobileSidebar);
  // Bubbling, so a control inside the drawer that handles Escape first (and prevents the default)
  // keeps it open. The key is consumed here (default prevented) so the Escape handlers on window,
  // like the reply preview's and the transcript's, leave their drafts alone.
  useEventListener(document, "keydown", (event) => {
    if (event.key !== "Escape" || isComposingKey(event) || event.defaultPrevented) return;
    if (!mobileSidebarOpen || isDesktop()) return;
    event.preventDefault();
    restoreFocus.current = true;
    setMobileSidebarOpen(false);
  });

  const swipeHandlers = {
    onTouchStartCapture: (event: TouchEvent) => {
      if (mobileSidebarOpen || event.touches.length !== 1 || isDesktop()) {
        swipeRef.current = null;
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      const startsAtEdge = isRtl()
        ? touch.clientX >= window.innerWidth - MOBILE_SIDEBAR_SWIPE_EDGE_PX
        : touch.clientX <= MOBILE_SIDEBAR_SWIPE_EDGE_PX;
      swipeRef.current = startsAtEdge ? { startX: touch.clientX, startY: touch.clientY } : null;
    },
    onTouchEndCapture: (event: TouchEvent) => {
      const swipe = swipeRef.current;
      swipeRef.current = null;
      const touch = event.changedTouches[0];
      if (!swipe || !touch || mobileSidebarOpen || isDesktop()) {
        return;
      }
      const horizontal = isRtl() ? swipe.startX - touch.clientX : touch.clientX - swipe.startX;
      const vertical = Math.abs(touch.clientY - swipe.startY);
      if (horizontal >= MOBILE_SIDEBAR_SWIPE_DISTANCE_PX && horizontal > vertical * 1.25) {
        setMobileSidebarOpen(true);
      }
    },
    onTouchCancelCapture: () => {
      swipeRef.current = null;
    },
  };

  return { mobileSidebarOpen, setMobileSidebarOpen, swipeHandlers };
}
