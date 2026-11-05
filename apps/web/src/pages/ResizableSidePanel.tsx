import { t } from "@lingui/core/macro";
import { phoneLayout, useIsMobile } from "@rakazo/ui-web/hooks/use-mobile";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  CHAT_MIN_WIDTH,
  DRAG_COLLAPSE_WIDTH,
  PANEL_MIN_WIDTH,
  useColumnLayout,
} from "../lib/column-layout";
import { usePanelFold } from "../lib/panel-fold";
import { useViewportWidth } from "../lib/use-viewport-width";
import { useBotsSidebarWidth } from "./shell/sidebar-layout";

const STORAGE_KEY = "rakazo:right-panel-width";
const MIN_WIDTH = PANEL_MIN_WIDTH;
// Wider than the reference 272px so all four tabs fit without scrolling.
const DEFAULT_WIDTH = 300;
const ABSOLUTE_MAX = 1000;

function readPreferredWidth() {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    if (saved >= MIN_WIDTH) return Math.min(ABSOLUTE_MAX, saved);
  } catch {
    /* Storage may be disabled. */
  }
  return DEFAULT_WIDTH;
}

export function ResizableSidePanel({
  open,
  panel,
  onRequestClose,
  children,
}: {
  open: boolean;
  panel: string;
  /** Called when the user drags the panel narrower than it can go. */
  onRequestClose?: () => void;
  children: ReactNode;
}) {
  const sidebarWidth = useBotsSidebarWidth();
  const [preferredWidth, setPreferredWidth] = useState(readPreferredWidth);
  const viewportWidth = useViewportWidth();
  const isMobile = useIsMobile();
  const columns = useColumnLayout();
  const setPanelRequest = columns?.setPanelRequest;
  // Asked for by the user (opened, or brought back while folded), the panel may push the
  // sidebar down to the rail. Narrowing the window gives that up again: the panel folds first.
  const [priority, setPriority] = useState(false);
  const wasOpen = useRef(open);
  const lastViewport = useRef(viewportWidth);
  useEffect(() => {
    if (open && !wasOpen.current) setPriority(true);
    if (!open) setPriority(false);
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (viewportWidth < lastViewport.current) setPriority(false);
    lastViewport.current = viewportWidth;
  }, [viewportWidth]);
  // The shared column layout decides how wide the panel may be and when it folds away.
  useEffect(() => {
    setPanelRequest?.({ open: open && !isMobile, width: preferredWidth, priority });
  }, [setPanelRequest, open, isMobile, preferredWidth, priority]);
  useEffect(
    () => () => setPanelRequest?.({ open: false, width: 0, priority: false }),
    [setPanelRequest],
  );
  const cramped = !isMobile && open && Boolean(columns?.panelFolded);
  // Only when even the rail leaves no room does a panel the user asked for float over the
  // thread; otherwise it folds away until there is room again.
  const overlay = cramped && priority;
  // A window narrowed all the way to the phone layout shows the thread, not a panel left open
  // from the wider window; the chat title brings it back.
  const [phoneFolded, setPhoneFolded] = useState(false);
  // Starts from the real layout, so a panel opened on a phone (or by a link) is not folded.
  const wasMobile = useRef(phoneLayout());
  useEffect(() => {
    // Read the layout itself: the hook reports desktop for one render before it measures.
    const phone = isMobile && phoneLayout();
    if (phone && !wasMobile.current && open) setPhoneFolded(true);
    if (!phone || !open) setPhoneFolded(false);
    wasMobile.current = phoneLayout();
  }, [isMobile, open]);
  const folded = (cramped && !priority) || (isMobile && open && phoneFolded);
  const fold = usePanelFold();
  const reportFolded = fold?.setFolded;
  useEffect(() => reportFolded?.(folded), [reportFolded, folded]);
  useEffect(() => () => reportFolded?.(false), [reportFolded]);
  const unfoldRequest = fold?.unfoldRequest ?? 0;
  const handledUnfold = useRef(unfoldRequest);
  useEffect(() => {
    if (unfoldRequest === handledUnfold.current) return;
    handledUnfold.current = unfoldRequest;
    setPriority(true);
    setPhoneFolded(false);
  }, [unfoldRequest]);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number; direction: number; raw: number } | null>(null);
  // Floating, the panel may cover the thread; in its column it leaves the thread its minimum.
  const room = viewportWidth - sidebarWidth - (overlay ? 0 : CHAT_MIN_WIDTH);
  const maxWidth = Math.max(MIN_WIDTH, Math.min(ABSOLUTE_MAX, room));
  const width = overlay
    ? Math.min(preferredWidth, maxWidth)
    : columns && columns.panelWidth > 0
      ? columns.panelWidth
      : Math.max(MIN_WIDTH, preferredWidth);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(preferredWidth));
    } catch {
      /* Storage may be disabled. */
    }
  }, [preferredWidth]);

  function stopDrag(event: PointerEvent<HTMLHRElement>) {
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function setWidthFromUser(next: number) {
    setPreferredWidth(Math.max(MIN_WIDTH, Math.min(ABSOLUTE_MAX, next)));
  }

  return (
    <aside
      data-testid="side-panel"
      data-panel={panel}
      data-overlay={overlay || undefined}
      data-folded={folded || undefined}
      inert={folded}
      style={{ "--panel-width": `${width}px` } as CSSProperties}
      className={`absolute inset-y-0 end-0 z-20 flex min-h-0 shrink-0 flex-col overflow-hidden bg-background ${overlay ? "desk:absolute" : "desk:relative"} ${dragging ? "" : "transition-[width,opacity] duration-450 ease-settle motion-reduce:transition-none"} ${open && !folded ? "w-full max-w-[384px] border-s-[0.5px] border-sidebar-border desk:w-(--panel-width) desk:max-w-none" : "pointer-events-none w-0 opacity-0"}`}
    >
      {open && !folded ? (
        <hr
          tabIndex={0}
          aria-label={t`Resize panel`}
          aria-orientation="vertical"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={maxWidth}
          aria-valuenow={Math.round(width)}
          className={`absolute inset-y-0 start-0 z-30 m-0 hidden h-full w-2 touch-none cursor-col-resize border-0 bg-transparent hover:bg-border focus-visible:bg-border focus-visible:outline-none ${overlay ? "" : "desk:block"}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              x: event.clientX,
              width,
              raw: width,
              direction: document.documentElement.dir === "rtl" ? -1 : 1,
            };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            drag.current.raw =
              drag.current.width + (drag.current.x - event.clientX) * drag.current.direction;
            setWidthFromUser(drag.current.raw);
          }}
          onPointerUp={(event) => {
            // Released well below the narrowest panel: the user is pushing it shut.
            const startWidth = drag.current?.width ?? preferredWidth;
            const closing = (drag.current?.raw ?? MIN_WIDTH) < DRAG_COLLAPSE_WIDTH;
            stopDrag(event);
            if (closing && onRequestClose) {
              setPreferredWidth(startWidth);
              onRequestClose();
            }
          }}
          onDoubleClick={() => setPreferredWidth(DEFAULT_WIDTH)}
          onPointerCancel={stopDrag}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragging(false);
          }}
          onKeyDown={(event) => {
            const direction = document.documentElement.dir === "rtl" ? -1 : 1;
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              setWidthFromUser(width + (event.key === "ArrowLeft" ? 32 : -32) * direction);
            } else if (event.key === "Home") {
              event.preventDefault();
              setWidthFromUser(MIN_WIDTH);
            } else if (event.key === "End") {
              event.preventDefault();
              setWidthFromUser(maxWidth);
            }
          }}
        />
      ) : null}
      {children}
    </aside>
  );
}
